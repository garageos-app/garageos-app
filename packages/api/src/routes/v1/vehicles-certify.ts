import { CertifyVehicleSchema, Prisma, type PrismaClient } from '@garageos/database';
import type { FastifyError, FastifyPluginAsync } from 'fastify';

import { businessError } from '../../lib/business-error.js';
import { certifyVehicleWithGarageCode, VehicleNotCertifiableError } from '../../lib/garage-code.js';
import { maskCustomer, resolvePiiVisibility } from '../../lib/pii-filter.js';
import { idParamSchema, vehicleDetailSelect } from '../../lib/vehicle-shared.js';
import { INVALID_VIN_CHECKSUM_DETAIL, validateVinIso3779 } from '../../lib/vin-checksum.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';
import { checkDuplicatePlateWarning, checkDuplicateVin } from './vehicles.js';

// POST /v1/vehicles/:id/certify — F-OFF-107, BR-004.
// Promotes a customer-created pending vehicle (F-CLI-104) to certified:
// optional corrections from the libretto, then the atomic
// pending→certified transition with garage_code assignment via
// certifyVehicleWithGarageCode (BR-021 retry included). Any tenant user
// (super_admin or mechanic) may certify — BR-004 has no role gate.
//
// RLS rationale: policy vehicles_update (migration 20260424100000:413-420)
// matches is_admin_role() OR created_by/certified_by tenant. A
// customer-created pending vehicle has BOTH tenant columns NULL, so under
// a tenant context the UPDATE would silently match 0 rows. The route
// therefore runs under withContext({ role: 'admin' }) with the explicit
// app-layer guards below as the entire security boundary (never RLS
// alone — the #154 lesson). The CHECK constraints chk_pending_consistency
// / chk_certified_consistency make any non-atomic transition invalid,
// which is why the helper moves all four columns in one UPDATE.
//
// BR-005 (VIN immutable) applies only AFTER certification: a corrected
// VIN is still legitimate here. No customer_tenant_relation is created
// (BR-004 does not establish one; it is born with the first
// intervention) and the owner PII is masked per BR-151.

function notFoundError(): FastifyError {
  return businessError('vehicle.not_found', 404, 'Veicolo non trovato.');
}

function notPendingError(): FastifyError {
  return businessError(
    'vehicle.certification.not_pending',
    422,
    'Il veicolo non è in attesa di certificazione.',
  );
}

// A guarded write matched 0 rows: re-read to tell "vehicle gone" (404)
// from "a concurrent certify won" (422 not_pending).
async function notCertifiableError(tx: PrismaClient, vehicleId: string): Promise<FastifyError> {
  const row = await tx.vehicle.findFirst({
    where: { id: vehicleId },
    select: { status: true },
  });
  return row ? notPendingError() : notFoundError();
}

const vehicleCertifyRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/v1/vehicles/:id/certify',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const body = CertifyVehicleSchema.parse(request.body);
      const tenantId = request.tenantId!;
      const cognitoSub = request.userId!;

      // BR-004 precondition: explicit "I inspected the libretto"
      // declaration, checked before any DB access.
      if (body.librettoVisioned !== true) {
        throw businessError(
          'vehicle.certification.libretto_required',
          422,
          'Conferma di aver visionato il libretto di circolazione.',
        );
      }

      return app.withContext({ role: 'admin' as const }, async (tx) => {
        // (cognitoSub, tenantId) lookup — see users.ts header.
        const user = await tx.user.findFirstOrThrow({
          where: { cognitoSub, tenantId },
          select: { id: true },
        });

        const existing = await tx.vehicle.findFirst({
          where: { id },
          select: { status: true, vin: true, plate: true, plateCountry: true },
        });
        if (!existing) {
          throw notFoundError();
        }
        // Covers certified AND archived: the certify trigger is "not
        // pending", one code for every non-pending status.
        if (existing.status !== 'pending') {
          throw notPendingError();
        }

        const corrections = body.corrections ?? {};

        // BR-001: the ISO 3779 checksum on a corrected VIN is advisory
        // (a mismatch is common on EU VINs — see routes/v1/vehicles.ts),
        // surfaced as a confirmable warning the mechanic acknowledges via
        // forceNonstandardVin; BR-005 does not apply yet (the vehicle is
        // not certified).
        if (corrections.vin !== undefined && corrections.vin !== existing.vin) {
          if (!body.forceNonstandardVin && !validateVinIso3779(corrections.vin)) {
            throw businessError(
              'vehicle.creation.invalid_vin_checksum',
              400,
              INVALID_VIN_CHECKSUM_DETAIL,
            );
          }
          await checkDuplicateVin(tx, corrections.vin);
        }

        // BR-002: plate collision is a confirmable warning, mirror of
        // PATCH /vehicles/:id.
        const newPlate = corrections.plate ?? existing.plate;
        const newPlateCountry = corrections.plateCountry ?? existing.plateCountry;
        if (newPlate !== existing.plate || newPlateCountry !== existing.plateCountry) {
          await checkDuplicatePlateWarning(tx, newPlate, newPlateCountry, body.force, id);
        }

        // Corrections CAS: guarded on status='pending' so a concurrent
        // certify cannot interleave between the read above and this write.
        if (Object.keys(corrections).length > 0) {
          const data: Record<string, unknown> = {};
          for (const [k, value] of Object.entries(corrections)) {
            data[k] =
              k === 'registrationDate' && typeof value === 'string' ? new Date(value) : value;
          }
          let count: number;
          try {
            ({ count } = await tx.vehicle.updateMany({
              where: { id, status: 'pending' },
              data,
            }));
          } catch (err) {
            // Race beyond the pre-check: another vehicle took this VIN
            // between checkDuplicateVin and the write.
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
              throw businessError(
                'vehicle.creation.duplicate_vin',
                409,
                `Esiste già un veicolo con VIN ${corrections.vin ?? existing.vin}.`,
              );
            }
            throw err;
          }
          if (count === 0) {
            throw await notCertifiableError(tx, id);
          }
        }

        // Atomic pending→certified transition: one UPDATE sets
        // garage_code + status + certified_at + certified_by_tenant_id
        // (BR-004 post-conditions), guarded on garage_code IS NULL — this
        // is the anti-double-certify CAS for the no-corrections path.
        try {
          await certifyVehicleWithGarageCode(tx, id, tenantId);
        } catch (err) {
          if (err instanceof VehicleNotCertifiableError) {
            throw await notCertifiableError(tx, id);
          }
          throw err;
        }

        // Direct insert instead of recordVehicleAccess: certification is a
        // discrete audit event, and the helper's BR-154 30-minute
        // (vehicleId, userId) dedup has no action filter — the mechanic has
        // virtually always just viewed this vehicle ('view' row from the
        // detail page), which would swallow the certify row. Failures must
        // never break the promotion (same stance as the helper).
        try {
          await tx.accessLog.create({
            data: {
              vehicleId: id,
              tenantId,
              userId: user.id,
              action: 'update',
              ...(request.ip ? { ipAddress: request.ip } : {}),
            },
          });
        } catch (err) {
          request.log.warn({ err, vehicleId: id }, 'access-log: certify write failed');
        }

        // TODO(F-CLI-notifications): push+email to the owning customer
        // (BR-004 post-condition, deferred — spec §scope decision 2).

        const reloaded = await tx.vehicle.findUniqueOrThrow({
          where: { id },
          select: vehicleDetailSelect,
        });
        const active = reloaded.ownerships[0] ?? null;
        const customerIds = active ? [active.customerId] : [];
        const visibleSet = await resolvePiiVisibility({ tx, tenantId, customerIds });

        const { ownerships: _drop, ...vehicleFields } = reloaded;
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
};

export default vehicleCertifyRoutes;
