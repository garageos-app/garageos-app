import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { businessError } from '../../lib/business-error.js';
import { decodeDateCompoundCursor, encodeCompoundCursor } from '../../lib/cursor.js';
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

// Detail projection — also used by list and create response (Tasks 2 & 3).
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
        return projectDetail(row);
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

        const cursorWhere = cursor
          ? {
              OR: [
                { interventionDate: { lt: new Date(`${cursor.d}T00:00:00.000Z`) } },
                {
                  interventionDate: new Date(`${cursor.d}T00:00:00.000Z`),
                  id: { lt: cursor.id },
                },
              ],
            }
          : {};

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
        const data = page.map(projectDetail);

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
};

export default mePrivateInterventionRoutes;
