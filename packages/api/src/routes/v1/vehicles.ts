import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { recordVehicleAccess } from '../../lib/access-log.js';
import { maskCustomer, resolvePiiVisibility } from '../../lib/pii-filter.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

// Shared Zod schemas for the two read-only endpoints. Inline at first
// — if a second vehicles file grows that needs them, factor out.
const searchQuerySchema = z
  .object({
    vin: z.string().length(17).optional(),
    plate: z.string().min(1).max(10).optional(),
    garage_code: z.string().min(1).max(12).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().optional(),
  })
  .refine((q) => [q.vin, q.plate, q.garage_code].filter((v) => v !== undefined).length === 1, {
    message: 'Exactly one of vin, plate, garage_code is required',
  });

const idParamSchema = z.object({
  id: z.uuid(),
});

// Current ownership is the single VehicleOwnership row with
// ended_at IS NULL, enforced by partial unique index
// uq_ownership_vehicle_active (BR-040 — migration
// 20260424100000:190-192). take:1 is defensive in case future rows
// leak through during a transfer window.
const vehicleOwnershipSelect = {
  where: { endedAt: null },
  select: {
    id: true,
    customerId: true,
    startedAt: true,
    customer: {
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        isBusiness: true,
        businessName: true,
        vatNumber: true,
      },
    },
  },
  take: 1,
} as const;

const vehicleSearchSelect = {
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
  ownerships: vehicleOwnershipSelect,
} as const;

function encodeCursor(id: string): string {
  return Buffer.from(JSON.stringify({ id }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): string | undefined {
  if (!cursor) return undefined;
  try {
    const obj = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      id?: string;
    };
    return typeof obj.id === 'string' ? obj.id : undefined;
  } catch {
    return undefined;
  }
}

const vehicleRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/vehicles/search',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request) => {
      const { vin, plate, garage_code, limit, cursor } = searchQuerySchema.parse(request.query);
      const tenantId = request.tenantId!;
      const cognitoSub = request.userId!;

      return app.withContext({ tenantId }, async (tx) => {
        // User lookup is the source of truth for the DB user id (the
        // JWT sub goes to cognito_sub). Matches the pattern in
        // users.ts — see that file's header comment for rationale.
        const user = await tx.user.findUniqueOrThrow({
          where: { cognitoSub },
          select: { id: true, locationId: true },
        });

        const where: Record<string, unknown> = {};
        if (vin) where.vin = vin;
        if (plate) where.plate = plate;
        if (garage_code) where.garageCode = garage_code;

        const cursorId = decodeCursor(cursor);
        const rows = await tx.vehicle.findMany({
          where,
          select: vehicleSearchSelect,
          orderBy: { id: 'asc' },
          take: limit + 1,
          ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
        });

        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;

        const customerIds = page
          .flatMap((v) => v.ownerships.map((o) => o.customerId))
          .filter((id): id is string => Boolean(id));
        const visibleSet = await resolvePiiVisibility({ tx, tenantId, customerIds });

        const data = page.map((v) => {
          const active = v.ownerships[0] ?? null;
          return {
            id: v.id,
            garageCode: v.garageCode,
            vin: v.vin,
            plate: v.plate,
            plateCountry: v.plateCountry,
            make: v.make,
            model: v.model,
            year: v.year,
            vehicleType: v.vehicleType,
            fuelType: v.fuelType,
            status: v.status,
            currentOwnership: active
              ? {
                  id: active.id,
                  startedAt: active.startedAt,
                  customer: maskCustomer(active.customer, visibleSet.has(active.customerId)),
                }
              : null,
          };
        });

        // BR-154: log every matched vehicle as search_match. Fire-and-
        // forget — the helper swallows errors into log.warn.
        await Promise.all(
          page.map((v) =>
            recordVehicleAccess({
              tx,
              vehicleId: v.id,
              tenantId,
              userId: user.id,
              ...(user.locationId ? { locationId: user.locationId } : {}),
              action: 'search_match',
              ipAddress: request.ip,
              log: request.log,
            }),
          ),
        );

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

  app.get(
    '/v1/vehicles/:id',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request, reply) => {
      const params = idParamSchema.parse(request.params);
      void params;
      return reply.code(501).send({ detail: 'not implemented' });
    },
  );
};

export default vehicleRoutes;
