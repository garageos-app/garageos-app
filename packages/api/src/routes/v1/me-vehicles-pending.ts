import { CreatePendingVehicleSchema, Prisma } from '@garageos/database';
import type { FastifyPluginAsync } from 'fastify';

import { businessError } from '../../lib/business-error.js';
import { validateVinIso3779 } from '../../lib/vin-checksum.js';
import { clientiContext } from '../../middleware/clienti-context.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireClientiPool } from '../../middleware/require-clienti-pool.js';

// POST /v1/me/vehicles/pending — F-CLI-104.
// A customer without a GarageOS code pre-registers their vehicle: the
// vehicle is created with status 'pending' (BR-003: customer-created
// vehicles start pending) and immediately owned by the caller via a
// single active ownership row (BR-040). Mandatory fields per BR-006 are
// enforced by CreatePendingVehicleSchema; the VIN must pass the ISO 3779
// checksum (BR-001) with NO forceNonstandardVin bypass — that exception
// is mechanic-only (workshop flow). A workshop later certifies the
// vehicle (PR2, out of scope here): no garageCode / certifiedBy* fields
// are written, satisfying the DB CHECK chk_pending_consistency
// (pending ⇒ garage_code NULL).
//
// RLS: the INSERT passes policy vehicles_insert via its
// created_by_customer_id IS NOT NULL arm. The security boundary is the
// app layer pinning createdByCustomerId + the ownership row to the
// authenticated caller (request.customerId, never the body) — never RLS
// alone (the #154 lesson).

// Response projection: exactly the envelope's vehicle fields.
const pendingVehicleSelect = {
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

// BR-001: VIN is globally unique across all vehicles (certified AND
// pending), hence the single duplicate code regardless of status.
function duplicateVinError() {
  return businessError(
    'vehicle.pending.duplicate_vin_certified',
    409,
    'Esiste già un veicolo registrato con questo telaio. Se è il tuo, chiedi il codice GarageOS alla tua officina.',
  );
}

const meVehiclesPendingRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/v1/me/vehicles/pending',
    {
      preHandler: [requireAuth, requireClientiPool, clientiContext],
    },
    async (request, reply) => {
      const body = CreatePendingVehicleSchema.parse(request.body);
      const customerId = request.customerId!;

      // BR-001 ISO 3779 checksum — no bypass on the customer surface.
      if (!validateVinIso3779(body.vin)) {
        throw businessError(
          'vehicle.creation.invalid_vin_checksum',
          400,
          "Il VIN non risulta valido. Controlla il libretto di circolazione; per veicoli storici o speciali rivolgiti a un'officina.",
        );
      }

      const result = await app.withContext({ customerId, role: 'user' }, async (tx) => {
        // Duplicate VIN pre-check (BR-001 global unique). The friendly
        // 409 here covers the common case; the P2002 catch below covers
        // the race between this read and the insert.
        const existing = await tx.vehicle.findFirst({
          where: { vin: body.vin },
          select: { id: true },
        });
        if (existing) {
          throw duplicateVinError();
        }

        let vehicle;
        try {
          vehicle = await tx.vehicle.create({
            data: {
              vin: body.vin,
              plate: body.plate,
              plateCountry: body.plateCountry,
              make: body.make,
              model: body.model,
              // Optional owner-declared technical fields (BR-003/BR-004:
              // non-authoritative until a workshop certifies). Conditional
              // spreads mirror the workshop create (routes/v1/vehicles.ts) so
              // an omitted field stays NULL rather than being written empty.
              ...(body.version ? { version: body.version } : {}),
              year: body.year,
              ...(body.registrationDate
                ? { registrationDate: new Date(body.registrationDate) }
                : {}),
              vehicleType: body.vehicleType,
              fuelType: body.fuelType,
              ...(body.engineDisplacement !== undefined
                ? { engineDisplacement: body.engineDisplacement }
                : {}),
              ...(body.powerKw !== undefined ? { powerKw: body.powerKw } : {}),
              ...(body.color ? { color: body.color } : {}),
              status: 'pending',
              createdByCustomerId: customerId,
            },
            select: pendingVehicleSelect,
          });
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            throw duplicateVinError();
          }
          throw err;
        }

        // BR-040: one active ownership per vehicle. The vehicle is born
        // in this transaction, so there is no race on
        // uq_ownership_vehicle_active.
        const ownership = await tx.vehicleOwnership.create({
          data: { vehicleId: vehicle.id, customerId, startedAt: new Date() },
          select: { id: true, startedAt: true },
        });

        return { vehicle, ownership };
      });

      return reply.code(201).send(result);
    },
  );
};

export default meVehiclesPendingRoutes;
