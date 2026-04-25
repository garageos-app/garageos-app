import { CreateVehicleSchema } from '@garageos/database';
import type { FastifyError, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { recordVehicleAccess } from '../../lib/access-log.js';
import { maskCustomer, resolvePiiVisibility } from '../../lib/pii-filter.js';
import { validateVinIso3779 } from '../../lib/vin-checksum.js';
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

// Reuses CreateVehicleSchema from @garageos/database verbatim (vehicle +
// customer discriminator + locationId + sendInvitationEmail +
// forceNonstandardVin) and layers the API-only `force` flag used to
// override BR-002 duplicate-plate warnings.
const CreateVehicleBodySchema = CreateVehicleSchema.extend({
  force: z.boolean().default(false),
});

// Problem+JSON factory with a specific machine code. Used for business-
// rule failures that the shared error handler cannot infer from the
// exception shape (the handler maps P2025 → 404 and ZodError → 400, but
// domain codes like vehicle.creation.duplicate_vin need an explicit
// path).
function businessError(code: string, status: number, detail: string): FastifyError {
  const err = new Error(detail) as FastifyError;
  err.name = code;
  err.statusCode = status;
  return err;
}

// BR-001: VIN must be globally unique. Duplicate VIN is a hard error
// (409) — no force-override path. Runs before the plate check because
// VIN duplicates are common (re-registration of the same vehicle) and
// failing fast saves a second findFirst round-trip.
async function checkDuplicateVin(
  tx: import('@garageos/database').PrismaClient,
  vin: string,
): Promise<void> {
  const existing = await tx.vehicle.findFirst({ where: { vin }, select: { id: true } });
  if (existing) {
    throw businessError(
      'vehicle.creation.duplicate_vin',
      409,
      `Esiste già un veicolo con VIN ${vin}.`,
    );
  }
}

// BR-002: plate uniqueness is per-country (an Italian "AB123CD" must
// not collide with a Spanish "AB123CD"). The check is a *warning* —
// the workshop can confirm with force=true if they know the plate has
// been transferred or the previous record is stale.
async function checkDuplicatePlateWarning(
  tx: import('@garageos/database').PrismaClient,
  plate: string,
  plateCountry: string,
  force: boolean,
): Promise<void> {
  if (force) return;
  const existing = await tx.vehicle.findFirst({
    where: { plate, plateCountry },
    select: { id: true },
  });
  if (existing) {
    throw businessError(
      'vehicle.creation.duplicate_plate_warning',
      409,
      `Esiste già un veicolo con targa ${plate}. Passa force=true per confermare.`,
    );
  }
}

interface ResolvedCustomer {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  cognitoSub: string | null;
  appInstalled: boolean;
  phone: string | null;
  status: 'active' | 'pending_verification' | 'deleted';
}

async function resolveCustomer(
  tx: import('@garageos/database').PrismaClient,
  customer: import('zod').infer<typeof CreateVehicleBodySchema>['customer'],
): Promise<{ customer: ResolvedCustomer; wasCreated: boolean }> {
  if (customer.mode === 'existing') {
    // `cognitoSub` is projected even though it isn't part of the API response —
    // Task 9's invitation logic skips sending an invite when the customer is
    // already linked to a Cognito identity. Drop only if that branch goes away.
    const row = await tx.customer.findUniqueOrThrow({
      where: { id: customer.customerId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        cognitoSub: true,
        appInstalled: true,
        phone: true,
        status: true,
      },
    });
    return { customer: row, wasCreated: false };
  }
  // create_new branch lands in Task 8.
  throw new Error('create_new branch not implemented yet');
}

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

// Detail shape: all public tech fields + certifiedAt/createdAt. Kept
// in sync by comment only with BR-153 "VISIBILE" — missing fields
// like version/color/displacement are added here explicitly.
const vehicleDetailSelect = {
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
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const tenantId = request.tenantId!;
      const cognitoSub = request.userId!;

      return app.withContext({ tenantId }, async (tx) => {
        const user = await tx.user.findUniqueOrThrow({
          where: { cognitoSub },
          select: { id: true, locationId: true },
        });

        const vehicle = await tx.vehicle.findUniqueOrThrow({
          where: { id },
          select: vehicleDetailSelect,
        });

        const active = vehicle.ownerships[0] ?? null;
        const customerIds = active ? [active.customerId] : [];
        const visibleSet = await resolvePiiVisibility({ tx, tenantId, customerIds });

        await recordVehicleAccess({
          tx,
          vehicleId: vehicle.id,
          tenantId,
          userId: user.id,
          ...(user.locationId ? { locationId: user.locationId } : {}),
          action: 'view',
          ipAddress: request.ip,
          log: request.log,
        });

        const { ownerships: _drop, ...vehicleFields } = vehicle;
        void _drop;
        return {
          vehicle: vehicleFields,
          currentOwnership: active
            ? {
                id: active.id,
                startedAt: active.startedAt,
                customer: maskCustomer(active.customer, visibleSet.has(active.customerId)),
              }
            : null,
        };
      });
    },
  );

  app.post(
    '/v1/vehicles',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request, reply) => {
      const body = CreateVehicleBodySchema.parse(request.body);

      // BR-001: VIN is validated for 17-char alphanumeric shape by the
      // base schema. ISO 3779 checksum is separate and can be bypassed
      // for pre-1981 / agricultural vehicles via forceNonstandardVin.
      if (!body.forceNonstandardVin && !validateVinIso3779(body.vehicle.vin)) {
        throw businessError(
          'vehicle.creation.invalid_vin_checksum',
          400,
          'Il VIN non rispetta il checksum ISO 3779. Usa forceNonstandardVin=true per veicoli storici o agricoli.',
        );
      }

      const tenantId = request.tenantId!;
      const cognitoSub = request.userId!;

      return app.withContext({ tenantId }, async (tx) => {
        const user = await tx.user.findUniqueOrThrow({
          where: { cognitoSub },
          select: { id: true, locationId: true },
        });

        // Location must belong to the requesting tenant. Done outside the
        // duplicate-VIN / plate checks because it is a precondition of the
        // whole flow — failing here is more informative than a 404 on the
        // ownership insert later.
        const location = await tx.location.findUnique({
          where: { id: body.locationId },
          select: { tenantId: true },
        });
        if (!location || location.tenantId !== tenantId) {
          throw businessError(
            'vehicle.creation.location_not_in_tenant',
            422,
            'La location indicata non appartiene al tenant corrente.',
          );
        }

        await checkDuplicateVin(tx, body.vehicle.vin);
        await checkDuplicatePlateWarning(
          tx,
          body.vehicle.plate,
          body.vehicle.plateCountry,
          body.force,
        );

        const { customer: resolved, wasCreated } = await resolveCustomer(tx, body.customer);
        void resolved;
        void wasCreated;

        void user; // data-path tasks use user.id / user.locationId.

        // Remaining logic lands in Tasks 6-9.
        reply.code(501);
        return { message: 'Not implemented yet' };
      });
    },
  );
};

export default vehicleRoutes;
