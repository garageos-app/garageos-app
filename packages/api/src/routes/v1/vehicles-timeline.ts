import { Buffer } from 'node:buffer';

import type { FastifyError, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { idParamSchema } from '../../lib/vehicle-shared.js';
import { dualPoolContext } from '../../middleware/dual-pool-context.js';
import { requireAuth } from '../../middleware/require-auth.js';

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
});

interface TimelineCursor {
  d: string; // ISO 'YYYY-MM-DD' of the last item's interventionDate
  id: string; // UUID of the last item, tie-breaker
}

function encodeCursor(c: TimelineCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): TimelineCursor | undefined {
  if (!cursor) return undefined;
  try {
    const obj = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      d?: string;
      id?: string;
    };
    if (typeof obj.d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(obj.d)) return undefined;
    if (typeof obj.id !== 'string') return undefined;
    return { d: obj.d, id: obj.id };
  } catch {
    return undefined;
  }
}

function businessError(code: string, status: number, detail: string): FastifyError {
  const err = new Error(detail) as FastifyError;
  err.name = code;
  err.statusCode = status;
  return err;
}

// Build a Prisma where clause that respects:
//   - vehicleId equality (always)
//   - optional [fromDate, toDate] window on interventionDate
//   - optional cursor predicate "(date < cD) OR (date = cD AND id < cId)"
// Extra fields (status filter for officina, soft-delete for private) are
// merged in by the caller via the spread.
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
  interventionDate: true,
  odometerKm: true,
  title: true,
  description: true,
  partsReplaced: true,
  status: true,
  tenant: { select: { businessName: true } },
  location: { select: { city: true } },
  interventionType: { select: { code: true, nameIt: true } },
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
      const cursor = decodeCursor(query.cursor);

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
        const shopRowsP =
          isOfficine && wantShop
            ? tx.intervention.findMany({
                where: buildVehicleDateCursorWhere(vehicleId, {
                  ...(fromDateUtc ? { fromDateUtc } : {}),
                  ...(toDateUtc ? { toDateUtc } : {}),
                  ...(cursor ? { cursor } : {}),
                }),
                select: shopRowSelect,
                orderBy: [{ interventionDate: 'desc' }, { id: 'desc' }],
                take: query.limit + 1,
              })
            : isClienti && wantShop
              ? tx.intervention.findMany({
                  where: buildVehicleDateCursorWhere(vehicleId, {
                    ...(fromDateUtc ? { fromDateUtc } : {}),
                    ...(toDateUtc ? { toDateUtc } : {}),
                    ...(cursor ? { cursor } : {}),
                  }),
                  select: shopRowSelect,
                  orderBy: [{ interventionDate: 'desc' }, { id: 'desc' }],
                  take: query.limit + 1,
                })
              : Promise.resolve([]);

        const privateRowsP =
          isClienti && wantPrivate
            ? tx.privateIntervention.findMany({
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
            : Promise.resolve([]);

        const [shopRows, privateRows] = await Promise.all([shopRowsP, privateRowsP]);

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

        const data = page.map((item) => {
          if (item.kind === 'shop') {
            const r = item.row;
            const attachments = attachmentByKey.get(`intervention:${r.id}`) ?? 0;
            return {
              kind: 'shop_intervention' as const,
              id: r.id,
              intervention_date: r.interventionDate.toISOString().slice(0, 10),
              odometer_km: r.odometerKm,
              type: { code: r.interventionType.code, name_it: r.interventionType.nameIt },
              title: r.title,
              description: r.description,
              parts_replaced_count: partsReplacedCount(r.partsReplaced),
              status: r.status,
              is_disputed: r.status === 'disputed',
              tenant: {
                business_name: r.tenant.businessName,
                location_city: r.location.city,
              },
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
                  cursor: encodeCursor({
                    d: lastItem.row.interventionDate.toISOString().slice(0, 10),
                    id: lastItem.row.id,
                  }),
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
};

export default vehicleTimelineRoutes;
