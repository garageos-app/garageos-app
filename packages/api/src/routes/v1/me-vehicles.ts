import type { FastifyError, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
import { clientiContext } from '../../middleware/clienti-context.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireClientiPool } from '../../middleware/require-clienti-pool.js';

// /v1/me/vehicles* — customer-app surface (APPENDICE_A §3.5,
// F-CLI-105 / F-CLI-106). Auth chain mirrors the officine routes but
// substitutes the clienti pool guard + clienti context: only the
// authenticated customer's own vehicles are reachable, where ownership
// is the single active row per BR-040 (`vehicle_ownerships.ended_at IS
// NULL`).
//
// No access_log writes here: BR-154 audit covers tenant-side reads
// (the access_logs table requires a non-NULL user_id pointing at
// `users`, which customers do not occupy). Customer-side access
// telemetry, if added, would land in a separate table and is not in
// PR 11 scope.

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
});

const idParamSchema = z.object({
  id: z.uuid(),
});

function businessError(code: string, status: number, detail: string): FastifyError {
  const err = new Error(detail) as FastifyError;
  err.name = code;
  err.statusCode = status;
  return err;
}

// Vehicle projection used by both endpoints. Mirrors the officine list
// shape (vehicles_search) minus the ownerships nesting — the customer
// IS the owner here, so currentOwnership is flattened to the single
// row's id + startedAt and the customer object is omitted.
const meVehicleListSelect = {
  id: true,
  garageCode: true,
  vin: true,
  plate: true,
  plateCountry: true,
  make: true,
  model: true,
  year: true,
  vehicleType: true,
  fuelType: true,
  status: true,
} as const;

const meVehicleDetailSelect = {
  id: true,
  garageCode: true,
  vin: true,
  plate: true,
  plateCountry: true,
  make: true,
  model: true,
  version: true,
  year: true,
  registrationDate: true,
  vehicleType: true,
  fuelType: true,
  engineDisplacement: true,
  powerKw: true,
  color: true,
  status: true,
  certifiedAt: true,
  createdAt: true,
} as const;

const meVehicleRoutes: FastifyPluginAsync = async (app) => {
  // GET /v1/me/vehicles — F-CLI-105.
  // Returns vehicles the authenticated customer currently owns
  // (BR-040: exactly one active ownership row per vehicle, partial
  // unique index uq_ownership_vehicle_active enforces it). Sold or
  // transferred vehicles, where ended_at IS NOT NULL, are filtered out
  // — the customer can no longer act on them.
  app.get(
    '/v1/me/vehicles',
    {
      preHandler: [requireAuth, requireClientiPool, clientiContext],
    },
    async (request) => {
      const { limit, cursor } = listQuerySchema.parse(request.query);
      const customerId = request.customerId!;

      // withContext sets app.current_customer so private_interventions /
      // push_tokens / dispute RLS policies are satisfied for any
      // follow-on read in the same handler. The vehicle and ownership
      // RLS policies are USING(true), so the listing itself does not
      // strictly require customer context — we set it for symmetry with
      // the officine pattern and to keep future extensions safe.
      return app.withContext({ customerId, role: 'user' }, async (tx) => {
        const cursorId = decodeCursor(cursor);
        const ownerships = await tx.vehicleOwnership.findMany({
          where: { customerId, endedAt: null },
          select: {
            id: true,
            startedAt: true,
            vehicle: { select: meVehicleListSelect },
          },
          orderBy: { id: 'asc' },
          take: limit + 1,
          ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
        });

        const hasMore = ownerships.length > limit;
        const page = hasMore ? ownerships.slice(0, limit) : ownerships;

        const data = page.map((o) => ({
          ...o.vehicle,
          currentOwnership: { id: o.id, startedAt: o.startedAt },
        }));

        const lastRow = page.at(-1);
        return {
          data,
          meta: {
            has_more: hasMore,
            ...(hasMore && lastRow ? { cursor: encodeCursor(lastRow.id) } : {}),
          },
        };
      });
    },
  );

  // GET /v1/me/vehicles/:id — F-CLI-106.
  // Returns the full technical scheda for a vehicle the authenticated
  // customer currently owns. Vehicles the customer never owned, or used
  // to own (ended_at NOT NULL), surface as 404 — same code as a missing
  // vehicle id. Returning 404 (not 403) avoids leaking the existence of
  // vehicles outside the customer's perimeter.
  app.get(
    '/v1/me/vehicles/:id',
    {
      preHandler: [requireAuth, requireClientiPool, clientiContext],
    },
    async (request) => {
      const { id: vehicleId } = idParamSchema.parse(request.params);
      const customerId = request.customerId!;

      return app.withContext({ customerId, role: 'user' }, async (tx) => {
        const ownership = await tx.vehicleOwnership.findFirst({
          where: { vehicleId, customerId, endedAt: null },
          select: {
            id: true,
            startedAt: true,
            vehicle: { select: meVehicleDetailSelect },
          },
        });
        if (!ownership) {
          throw businessError(
            'me.vehicle.not_found',
            404,
            'Veicolo non trovato o non più di tua proprietà.',
          );
        }

        return {
          vehicle: ownership.vehicle,
          currentOwnership: {
            id: ownership.id,
            startedAt: ownership.startedAt,
          },
        };
      });
    },
  );
};

export default meVehicleRoutes;
