import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { businessError } from '../../lib/business-error.js';
import { decodeDateCompoundCursor, encodeCompoundCursor } from '../../lib/cursor.js';
import {
  assertInterventionTypeExists,
  assertNotFutureInterventionDate,
} from '../../lib/intervention-shared.js';
import { clientiContext } from '../../middleware/clienti-context.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireClientiPool } from '../../middleware/require-clienti-pool.js';

// /v1/me/private-interventions* — customer-app private interventions
// CRUD (APPENDICE_A §3.7, F-CLI-201/202/203). RLS policy
// private_int_isolation (USING customer_id = current_customer_id()) is
// the primary BR-080 enforcement; the application-layer customerId scope
// is a defense-in-depth (lesson: feedback_rls_split_lookup_auth_table).
//
// BR-082: detail / patch / delete by id+customerId only, no vehicle
// ownership check — private interventions stay accessible to the original
// customer after the vehicle is transferred. List per-vehicle (separate
// endpoint) does require current ownership.

const idParamSchema = z.object({ id: z.uuid() });

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
});

const vehicleIdParamSchema = z.object({ id: z.uuid() });

const createBodySchema = z
  .object({
    intervention_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'intervention_date deve essere YYYY-MM-DD'),
    odometer_km: z.number().int().min(0).max(9_999_999).nullable(),
    intervention_type_id: z.uuid().nullable(),
    custom_type: z.string().min(1).max(150).nullable(),
    description: z.string().min(1).max(5000),
  })
  .refine(
    (b) =>
      (b.intervention_type_id !== null && b.custom_type === null) ||
      (b.intervention_type_id === null && b.custom_type !== null),
    {
      message: 'Specifica esattamente uno tra intervention_type_id e custom_type',
      path: ['intervention_type_id'],
    },
  );

const patchBodySchema = z
  .object({
    intervention_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'intervention_date deve essere YYYY-MM-DD')
      .optional(),
    odometer_km: z.number().int().min(0).max(9_999_999).nullable().optional(),
    intervention_type_id: z.uuid().nullable().optional(),
    custom_type: z.string().min(1).max(150).nullable().optional(),
    description: z.string().min(1).max(5000).optional(),
  })
  .strict(); // reject unknown keys to fail fast on client typos

// Detail projection — reused by detail, list, and create responses.
const detailSelect = {
  id: true,
  vehicleId: true,
  interventionDate: true,
  odometerKm: true,
  customType: true,
  description: true,
  createdAt: true,
  updatedAt: true,
  interventionType: { select: { id: true, nameIt: true } },
} as const;

type DetailRow = {
  id: string;
  vehicleId: string;
  interventionDate: Date;
  odometerKm: number | null;
  customType: string | null;
  description: string;
  createdAt: Date;
  updatedAt: Date;
  interventionType: { id: string; nameIt: string } | null;
};

function projectDetail(r: DetailRow) {
  return {
    id: r.id,
    vehicle_id: r.vehicleId,
    intervention_date: r.interventionDate.toISOString().slice(0, 10),
    odometer_km: r.odometerKm,
    type: r.interventionType
      ? { id: r.interventionType.id, name_it: r.interventionType.nameIt }
      : null,
    custom_type: r.customType,
    description: r.description,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}

type AttachmentForDetail = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: Date;
};

function serializeAttachmentForDetail(a: AttachmentForDetail) {
  return {
    id: a.id,
    file_name: a.fileName,
    mime_type: a.mimeType,
    size_bytes: a.sizeBytes,
    created_at: a.createdAt.toISOString(),
  };
}

const mePrivateInterventionRoutes: FastifyPluginAsync = async (app) => {
  // GET /v1/me/private-interventions/:id — F-CLI-202
  app.get(
    '/v1/me/private-interventions/:id',
    {
      preHandler: [requireAuth, requireClientiPool, clientiContext],
    },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const customerId = request.customerId!;

      return app.withContext({ customerId, role: 'user' }, async (tx) => {
        const row = await tx.privateIntervention.findFirst({
          where: { id, customerId, deletedAt: null },
          select: detailSelect,
        });
        if (!row) {
          throw businessError(
            'private_intervention.not_found',
            404,
            'Intervento privato non trovato.',
          );
        }

        const attachments = await tx.attachment.findMany({
          where: {
            ownerType: 'private_intervention',
            ownerId: id,
            processed: true,
            deletedAt: null,
          },
          select: {
            id: true,
            fileName: true,
            mimeType: true,
            sizeBytes: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'asc' },
        });

        return {
          ...projectDetail(row),
          attachments: attachments.map(serializeAttachmentForDetail),
        };
      });
    },
  );

  // GET /v1/me/vehicles/:id/private-interventions — F-CLI-201
  app.get(
    '/v1/me/vehicles/:id/private-interventions',
    {
      preHandler: [requireAuth, requireClientiPool, clientiContext],
    },
    async (request) => {
      const { id: vehicleId } = vehicleIdParamSchema.parse(request.params);
      const { limit, cursor: cursorParam } = listQuerySchema.parse(request.query);
      const customerId = request.customerId!;

      // `d` is a date-only string (YYYY-MM-DD); decodeDateCompoundCursor
      // guards against hand-crafted cursors with non-date payloads so we
      // never feed Invalid Date into the Prisma where below.
      const cursor = decodeDateCompoundCursor('d', cursorParam, 'date');

      return app.withContext({ customerId, role: 'user' }, async (tx) => {
        // Per BR-082, list per-vehicle requires the customer to currently
        // own the vehicle (unlike detail-by-id, which stays accessible
        // after transfer).
        const ownership = await tx.vehicleOwnership.findFirst({
          where: { vehicleId, customerId, endedAt: null },
          select: { id: true },
        });
        if (!ownership) {
          throw businessError(
            'me.vehicle.not_found',
            404,
            'Veicolo non trovato o non più di tua proprietà.',
          );
        }

        let cursorWhere: Record<string, unknown> = {};
        if (cursor) {
          const cursorDateUtc = new Date(`${cursor.d}T00:00:00.000Z`);
          cursorWhere = {
            OR: [
              { interventionDate: { lt: cursorDateUtc } },
              { interventionDate: cursorDateUtc, id: { lt: cursor.id } },
            ],
          };
        }

        const rows = await tx.privateIntervention.findMany({
          where: {
            customerId,
            vehicleId,
            deletedAt: null,
            ...cursorWhere,
          },
          select: detailSelect,
          orderBy: [{ interventionDate: 'desc' }, { id: 'desc' }],
          take: limit + 1,
        });

        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;

        // Single groupBy across page ids — avoids N+1 query.
        const pageIds = page.map((r) => r.id);
        const buckets =
          pageIds.length > 0
            ? await tx.attachment.groupBy({
                by: ['ownerId'],
                where: {
                  ownerType: 'private_intervention',
                  ownerId: { in: pageIds },
                  processed: true,
                  deletedAt: null,
                },
                _count: { _all: true },
              })
            : [];
        const countById = new Map<string, number>(buckets.map((b) => [b.ownerId, b._count._all]));

        const data = page.map((r) => ({
          ...projectDetail(r),
          attachments_count: countById.get(r.id) ?? 0,
        }));

        const lastRow = page.at(-1);
        const nextCursor =
          hasMore && lastRow
            ? encodeCompoundCursor(
                'd',
                lastRow.interventionDate.toISOString().slice(0, 10),
                lastRow.id,
              )
            : undefined;

        return {
          data,
          meta: {
            has_more: hasMore,
            ...(nextCursor ? { cursor: nextCursor } : {}),
          },
        };
      });
    },
  );

  // POST /v1/me/vehicles/:id/private-interventions — F-CLI-203
  app.post(
    '/v1/me/vehicles/:id/private-interventions',
    {
      preHandler: [requireAuth, requireClientiPool, clientiContext],
    },
    async (request, reply) => {
      const { id: vehicleId } = vehicleIdParamSchema.parse(request.params);
      const body = createBodySchema.parse(request.body);
      const customerId = request.customerId!;

      return app.withContext({ customerId, role: 'user' }, async (tx) => {
        // BR-080 guard at create: customer must currently own the vehicle.
        // 422 (not 404) differentiates "you can't act here" from "thing
        // doesn't exist"; the distinct code lets the mobile UI surface
        // a specific message.
        const ownership = await tx.vehicleOwnership.findFirst({
          where: { vehicleId, customerId, endedAt: null },
          select: { id: true },
        });
        if (!ownership) {
          throw businessError(
            'private_intervention.vehicle_not_owned',
            422,
            'Puoi registrare interventi privati solo su veicoli che possiedi.',
          );
        }

        // BR-069 mirror: future-dated private interventions rejected at
        // the same UTC-midnight anchor as officina interventions.ts.
        const interventionDateUtc = assertNotFutureInterventionDate(
          body.intervention_date,
          'private_intervention.date_future',
          'Non è possibile registrare interventi futuri.',
        );

        // FK existence for intervention_type. See helper JSDoc for RLS
        // rationale (intervention_types is permissive read post 20260427120000).
        // FK Restrict prevents a dangling reference post-creation.
        if (body.intervention_type_id !== null) {
          await assertInterventionTypeExists(tx, body.intervention_type_id);
        }

        // BR-085: anti-spam 50 / rolling 24h. Counts both alive and soft-
        // deleted rows — the limit is on CREATE rate, not on row count,
        // so soft-delete after the fact does not refresh the budget.
        // Race window: two parallel POSTs may both observe count=49 and
        // succeed (= 51 in DB). Acceptable for the anti-spam threat
        // model; a DB advisory lock would over-engineer this.
        const countLast24h = await tx.privateIntervention.count({
          where: {
            customerId,
            createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
          },
        });
        if (countLast24h >= 50) {
          throw businessError(
            'private_intervention.rate_limit',
            429,
            'Hai raggiunto il limite giornaliero di interventi privati (50/giorno).',
          );
        }

        const row = await tx.privateIntervention.create({
          data: {
            customerId,
            vehicleId,
            interventionTypeId: body.intervention_type_id,
            customType: body.custom_type,
            interventionDate: interventionDateUtc,
            odometerKm: body.odometer_km,
            description: body.description,
          },
          select: detailSelect,
        });

        reply.code(201);
        return { ...projectDetail(row), attachments: [] };
      });
    },
  );

  // PATCH /v1/me/private-interventions/:id — F-CLI-204 (update)
  app.patch(
    '/v1/me/private-interventions/:id',
    {
      preHandler: [requireAuth, requireClientiPool, clientiContext],
    },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const body = patchBodySchema.parse(request.body);
      const customerId = request.customerId!;

      return app.withContext({ customerId, role: 'user' }, async (tx) => {
        // 1. Load current row (BR-080 RLS + app-layer scope).
        const current = await tx.privateIntervention.findFirst({
          where: { id, customerId, deletedAt: null },
          select: {
            id: true,
            interventionTypeId: true,
            customType: true,
          },
        });
        if (!current) {
          throw businessError(
            'private_intervention.not_found',
            404,
            'Intervento privato non trovato.',
          );
        }

        // 2. Merged XOR check: post-merge state must have exactly one of
        //    interventionTypeId / customType non-null.
        const mergedTypeId =
          'intervention_type_id' in body ? body.intervention_type_id! : current.interventionTypeId;
        const mergedCustomType = 'custom_type' in body ? body.custom_type! : current.customType;
        if ((mergedTypeId !== null) === (mergedCustomType !== null)) {
          throw businessError(
            'VALIDATION_ERROR',
            422,
            'Specifica esattamente uno tra intervention_type_id e custom_type.',
          );
        }

        // 3. Future-date guard (only if intervention_date in payload).
        if (body.intervention_date !== undefined) {
          assertNotFutureInterventionDate(
            body.intervention_date,
            'private_intervention.date_future',
            'Non è possibile registrare interventi futuri.',
          );
        }

        // 4. Type existence (only if intervention_type_id provided and non-null).
        // The explicit `!== null && !== undefined` mirrors POST: in the
        // PATCH body, undefined means "field omitted" (no validation needed),
        // null means "explicit clear to custom_type" (also no validation —
        // there's no id to verify).
        if (body.intervention_type_id !== null && body.intervention_type_id !== undefined) {
          await assertInterventionTypeExists(tx, body.intervention_type_id);
        }

        // 5. Build update data — only fields explicitly in body.
        //    Empty body → data = {} → Prisma still touches updatedAt.
        const data: {
          interventionDate?: Date;
          odometerKm?: number | null;
          interventionTypeId?: string | null;
          customType?: string | null;
          description?: string;
        } = {};
        if (body.intervention_date !== undefined) {
          data.interventionDate = new Date(`${body.intervention_date}T00:00:00.000Z`);
        }
        if ('odometer_km' in body) data.odometerKm = body.odometer_km!;
        if ('intervention_type_id' in body) data.interventionTypeId = body.intervention_type_id!;
        if ('custom_type' in body) data.customType = body.custom_type!;
        if (body.description !== undefined) data.description = body.description;

        const row = await tx.privateIntervention.update({
          where: { id },
          data,
          select: detailSelect,
        });

        const attachments = await tx.attachment.findMany({
          where: {
            ownerType: 'private_intervention',
            ownerId: id,
            processed: true,
            deletedAt: null,
          },
          select: {
            id: true,
            fileName: true,
            mimeType: true,
            sizeBytes: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'asc' },
        });

        return {
          ...projectDetail(row),
          attachments: attachments.map(serializeAttachmentForDetail),
        };
      });
    },
  );

  // DELETE /v1/me/private-interventions/:id — F-CLI-204 (soft delete)
  app.delete(
    '/v1/me/private-interventions/:id',
    {
      preHandler: [requireAuth, requireClientiPool, clientiContext],
    },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const customerId = request.customerId!;

      return app.withContext({ customerId, role: 'user' }, async (tx) => {
        // BR-084 soft delete. updateMany with deletedAt:null in the where
        // predicate makes the operation idempotent: already-deleted rows
        // match zero, count=0 → 404. Atomic single round trip.
        const result = await tx.privateIntervention.updateMany({
          where: { id, customerId, deletedAt: null },
          data: { deletedAt: new Date() },
        });
        if (result.count === 0) {
          throw businessError(
            'private_intervention.not_found',
            404,
            'Intervento privato non trovato.',
          );
        }

        reply.code(204);
        // Returning void from a Fastify handler with reply.code(204) sends
        // an empty body. Returning {} would also work but is less idiomatic.
        return;
      });
    },
  );
};

export default mePrivateInterventionRoutes;
