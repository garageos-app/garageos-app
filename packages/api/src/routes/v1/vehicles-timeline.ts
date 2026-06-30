import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { decodeDateCompoundCursor, encodeCompoundCursor } from '../../lib/cursor.js';
import { businessError } from '../../lib/business-error.js';
import { isWikiWindowOpen } from '../../lib/intervention-shared.js';
import { idParamSchema } from '../../lib/vehicle-shared.js';
import { dualPoolContext } from '../../middleware/dual-pool-context.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

// GET /v1/vehicles/:id/timeline — APPENDICE_A §2.5 (F-OFF-105 /
// F-CLI-201 / F-CLI-205). Visibility per spec §2.5:
// officine sees shop cross-tenant (BR-150/BR-153), customer-owner
// sees shop + own private, customer non-owner 403, private of past
// owners always hidden. Cursor merges both sources by
// (interventionDate DESC, id DESC).

const timelineQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
  type: z.enum(['all', 'shop_only', 'private_only']).default('all'),
  from_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'from_date must be YYYY-MM-DD')
    .optional(),
  to_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'to_date must be YYYY-MM-DD')
    .optional(),
  // Filter shop interventions to the given officine (BR-150/BR-153 shared
  // logbook). Comma-separated tenant UUIDs; absent ⇒ no filter (all
  // officine). Validated as UUIDs so a malformed value is a 400, not a
  // Postgres cast error.
  tenant_ids: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    )
    .pipe(z.array(z.string().uuid())),
});

// Build a Prisma where clause that respects:
//   - vehicleId equality (always)
//   - optional [fromDate, toDate] window on interventionDate
//   - optional cursor predicate "(date < cD) OR (date = cD AND id < cId)"
// Extra fields (status filter for officina, soft-delete for private) are
// merged in by the caller via the spread.
type TimelineCursor = { d: string; id: string };
type DateWindow = { fromDateUtc?: Date; toDateUtc?: Date; cursor?: TimelineCursor };

function buildVehicleDateCursorWhere(vehicleId: string, opts: DateWindow): Record<string, unknown> {
  const where: Record<string, unknown> = { vehicleId };

  if (opts.fromDateUtc || opts.toDateUtc) {
    const range: Record<string, Date> = {};
    if (opts.fromDateUtc) range.gte = opts.fromDateUtc;
    if (opts.toDateUtc) range.lte = opts.toDateUtc;
    where.interventionDate = range;
  }

  if (opts.cursor) {
    const cursorDateUtc = new Date(`${opts.cursor.d}T00:00:00.000Z`);
    where.OR = [
      { interventionDate: { lt: cursorDateUtc } },
      { interventionDate: cursorDateUtc, id: { lt: opts.cursor.id } },
    ];
  }

  return where;
}

const shopRowSelect = {
  id: true,
  tenantId: true,
  interventionDate: true,
  odometerKm: true,
  title: true,
  description: true,
  partsReplaced: true,
  status: true,
  // BR-062 wiki window is a composite predicate (wikiLockedAt IS NULL
  // AND now - createdAt < 48h AND firstSeenByCustomerAt IS NULL). The
  // DTO surfaces the computed `wiki_window_open` boolean below; these
  // three raw fields are selected only as inputs to that computation.
  wikiLockedAt: true,
  createdAt: true,
  firstSeenByCustomerAt: true,
  tenant: { select: { businessName: true } },
  interventionType: { select: { id: true, code: true, nameIt: true } },
} as const;

const privateRowSelect = {
  id: true,
  interventionDate: true,
  odometerKm: true,
  customType: true,
  description: true,
} as const;

// JSON.parse on partsReplaced is unnecessary — Prisma already deserializes
// JSON columns. Defensive Array.isArray covers the case where the column
// has been hand-edited to non-array shape (shouldn't happen given the
// `@default("[]")` and the API-side schema, but a misshapen row should
// not crash the timeline).
function partsReplacedCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

const vehicleTimelineRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/vehicles/:id/timeline',
    {
      preHandler: [requireAuth, dualPoolContext],
    },
    async (request) => {
      const { id: vehicleId } = idParamSchema.parse(request.params);
      const query = timelineQuerySchema.parse(request.query);

      // Date filters arrive as YYYY-MM-DD; align to UTC midnight to
      // match the way interventionDate is stored (Prisma @db.Date is
      // serialized as midnight-UTC Date instances).
      const fromDateUtc = query.from_date
        ? new Date(`${query.from_date}T00:00:00.000Z`)
        : undefined;
      const toDateUtc = query.to_date ? new Date(`${query.to_date}T00:00:00.000Z`) : undefined;
      // `d` is a date-only string (YYYY-MM-DD); decodeDateCompoundCursor
      // guards against hand-crafted cursors with non-date payloads
      // (returns undefined → page 1 fallback) so we never feed Invalid
      // Date into the Prisma `where` clause below.
      const cursor = decodeDateCompoundCursor('d', query.cursor, 'date');

      const wantShop = query.type === 'all' || query.type === 'shop_only';
      const wantPrivate = query.type === 'all' || query.type === 'private_only';

      const isOfficine = request.authPool === 'officine';
      const isClienti = request.authPool === 'clienti';

      // Migration 0003 (split_interventions_attachments_rls) made
      // SELECT cross-tenant on interventions, attachments, tenants,
      // locations, and intervention_types — i.e. the entire shape of
      // shopRowSelect joined here. The pool-bound `role: 'user'` ctx
      // is sufficient: every WHERE in this handler scopes to vehicleId
      // (and to customerId + deletedAt for the private query), and
      // ownership for clienti is verified above. No writes run here.
      const ctx = isOfficine
        ? { tenantId: request.tenantId!, role: 'user' as const }
        : { customerId: request.customerId!, role: 'user' as const };

      return app.withContext(ctx, async (tx) => {
        // Vehicle existence first — 404 before any pool-specific work
        // so the API behaves the same shape as GET /vehicles/:id.
        await tx.vehicle.findUniqueOrThrow({
          where: { id: vehicleId },
          select: { id: true },
        });

        // Customer ownership precondition (spec §2.5). Officine skip:
        // BR-150 grants cross-vehicle read.
        if (isClienti) {
          const ownership = await tx.vehicleOwnership.findFirst({
            where: { vehicleId, customerId: request.customerId!, endedAt: null },
            select: { id: true },
          });
          if (!ownership) {
            throw businessError(
              'vehicle.timeline.not_owner',
              403,
              'Solo il proprietario attivo può consultare la timeline del veicolo.',
            );
          }
        }

        // Per-source queries: each ordered by (interventionDate DESC,
        // id DESC) and limit+1, enough for the merge to fill the page
        // and detect has_more. Officine never reads private.
        // Sequential awaits: Promise.all on `tx` (single Prisma $transaction
        // connection) serialises queries internally and triggers the pg
        // "client.query() … already executing" warning — see PR #95. The
        // two findMany calls cost ~250 ms each at Supabase; sequential
        // execution adds ~250 ms vs the (illusory) parallel plan.
        // Shop where: date/cursor window + optional officina filter
        // (tenant_ids). Identical for both pools — built once.
        const shopWhere = {
          ...buildVehicleDateCursorWhere(vehicleId, {
            ...(fromDateUtc ? { fromDateUtc } : {}),
            ...(toDateUtc ? { toDateUtc } : {}),
            ...(cursor ? { cursor } : {}),
          }),
          ...(query.tenant_ids.length > 0 ? { tenantId: { in: query.tenant_ids } } : {}),
        };

        const shopRows =
          (isOfficine || isClienti) && wantShop
            ? await tx.intervention.findMany({
                where: shopWhere,
                select: shopRowSelect,
                orderBy: [{ interventionDate: 'desc' }, { id: 'desc' }],
                take: query.limit + 1,
              })
            : [];

        const privateRows =
          isClienti && wantPrivate
            ? await tx.privateIntervention.findMany({
                where: {
                  ...buildVehicleDateCursorWhere(vehicleId, {
                    ...(fromDateUtc ? { fromDateUtc } : {}),
                    ...(toDateUtc ? { toDateUtc } : {}),
                    ...(cursor ? { cursor } : {}),
                  }),
                  customerId: request.customerId!,
                  deletedAt: null,
                },
                select: privateRowSelect,
                orderBy: [{ interventionDate: 'desc' }, { id: 'desc' }],
                take: query.limit + 1,
              })
            : [];

        // Attachments: single groupBy across both owner types, joined
        // on the row id back into the response.
        const shopIds = shopRows.map((r) => r.id);
        const privateIds = privateRows.map((r) => r.id);
        const attachmentBuckets =
          shopIds.length + privateIds.length > 0
            ? await tx.attachment.groupBy({
                by: ['ownerType', 'ownerId'],
                where: {
                  OR: [
                    ...(shopIds.length > 0
                      ? [{ ownerType: 'intervention' as const, ownerId: { in: shopIds } }]
                      : []),
                    ...(privateIds.length > 0
                      ? [
                          {
                            ownerType: 'private_intervention' as const,
                            ownerId: { in: privateIds },
                          },
                        ]
                      : []),
                  ],
                },
                _count: { _all: true },
              })
            : [];
        const attachmentByKey = new Map<string, number>();
        for (const bucket of attachmentBuckets) {
          attachmentByKey.set(`${bucket.ownerType}:${bucket.ownerId}`, bucket._count._all);
        }

        // Merge sort by (interventionDate DESC, id DESC). Bounded by
        // 2*(limit+1) ≤ 202 rows, so a plain Array.sort is fine.
        type ShopItem = { kind: 'shop'; row: (typeof shopRows)[number] };
        type PrivateItem = { kind: 'private'; row: (typeof privateRows)[number] };
        type Item = ShopItem | PrivateItem;
        const merged: Item[] = [
          ...shopRows.map((r): Item => ({ kind: 'shop', row: r })),
          ...privateRows.map((r): Item => ({ kind: 'private', row: r })),
        ];
        merged.sort((a, b) => {
          const dt = b.row.interventionDate.getTime() - a.row.interventionDate.getTime();
          if (dt !== 0) return dt;
          return a.row.id < b.row.id ? 1 : a.row.id > b.row.id ? -1 : 0;
        });

        const hasMore = merged.length > query.limit;
        const page = hasMore ? merged.slice(0, query.limit) : merged;

        // Single `now` snapshot for the whole page so two rows created
        // milliseconds apart at the 48h boundary report a consistent
        // wiki_window_open in the same response.
        const now = new Date();

        // BR-150/BR-153: the timeline is cross-tenant for officine, but edit
        // and dispute-response are owner-only mutations. Surface per-row
        // ownership so the web client renders other tenants' interventions
        // read-only. For clienti there is no owning tenant (editing is
        // officina-only), so it is always false.
        const callerTenantId = isOfficine ? request.tenantId! : null;

        const data = page.map((item) => {
          if (item.kind === 'shop') {
            const r = item.row;
            const attachments = attachmentByKey.get(`intervention:${r.id}`) ?? 0;
            return {
              kind: 'shop_intervention' as const,
              id: r.id,
              intervention_date: r.interventionDate.toISOString().slice(0, 10),
              odometer_km: r.odometerKm,
              type: {
                id: r.interventionType.id,
                code: r.interventionType.code,
                name_it: r.interventionType.nameIt,
              },
              title: r.title,
              description: r.description,
              parts_replaced_count: partsReplacedCount(r.partsReplaced),
              status: r.status,
              is_disputed: r.status === 'disputed',
              wiki_window_open: isWikiWindowOpen(
                r.wikiLockedAt,
                r.firstSeenByCustomerAt,
                r.createdAt,
                now,
              ),
              tenant: {
                id: r.tenantId,
                business_name: r.tenant.businessName,
              },
              viewer_is_owner: r.tenantId === callerTenantId,
              has_attachments: attachments > 0,
              attachments_count: attachments,
            };
          }
          const r = item.row;
          const attachments = attachmentByKey.get(`private_intervention:${r.id}`) ?? 0;
          return {
            kind: 'private_intervention' as const,
            id: r.id,
            intervention_date: r.interventionDate.toISOString().slice(0, 10),
            odometer_km: r.odometerKm,
            custom_type: r.customType,
            description: r.description,
            has_attachments: attachments > 0,
            attachments_count: attachments,
          };
        });

        // Page-level counts (per spec sample — page scope, not history).
        const shopCount = data.filter((d) => d.kind === 'shop_intervention').length;
        const privateCount = data.length - shopCount;

        const lastItem = page.at(-1);
        return {
          data,
          meta: {
            has_more: hasMore,
            ...(hasMore && lastItem
              ? {
                  cursor: encodeCompoundCursor(
                    'd',
                    lastItem.row.interventionDate.toISOString().slice(0, 10),
                    lastItem.row.id,
                  ),
                }
              : {}),
            total_interventions: data.length,
            shop_count: shopCount,
            private_count: privateCount,
          },
        };
      });
    },
  );

  // GET /v1/vehicles/:id/timeline/officine — distinct list of officine that
  // have at least one shop intervention on this vehicle. Feeds the web
  // timeline officina filter + stable per-officina color assignment (the
  // list is independent of pagination, so colors don't shift as pages load).
  //
  // Officine-only: the filter UI lives in the workshop web app. RLS
  // `interventions_read` is permissive cross-tenant, so the distinct query
  // sees every tenant's interventions on the vehicle (BR-150).
  app.get(
    '/v1/vehicles/:id/timeline/officine',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request) => {
      const { id: vehicleId } = idParamSchema.parse(request.params);
      const tenantId = request.tenantId!;

      return app.withContext({ tenantId, role: 'user' as const }, async (tx) => {
        // Vehicle existence first — 404 mirrors the timeline endpoint.
        await tx.vehicle.findUniqueOrThrow({
          where: { id: vehicleId },
          select: { id: true },
        });

        const rows = await tx.intervention.findMany({
          where: { vehicleId },
          distinct: ['tenantId'],
          select: { tenantId: true, tenant: { select: { businessName: true } } },
        });

        const officine = rows
          .map((r) => ({
            tenant_id: r.tenantId,
            business_name: r.tenant.businessName,
            viewer_is_owner: r.tenantId === tenantId,
          }))
          .sort((a, b) => a.business_name.localeCompare(b.business_name, 'it'));

        return { data: officine };
      });
    },
  );
};

export default vehicleTimelineRoutes;
