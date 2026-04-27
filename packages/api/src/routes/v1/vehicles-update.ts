import { UpdateVehicleSchema } from '@garageos/database';
import type { FastifyPluginAsync } from 'fastify';

import { recordVehicleAccess } from '../../lib/access-log.js';
import { businessError } from '../../lib/business-error.js';
import { maskCustomer, resolvePiiVisibility } from '../../lib/pii-filter.js';
import { idParamSchema, vehicleDetailSelect } from '../../lib/vehicle-shared.js';
import { validateVinIso3779 } from '../../lib/vin-checksum.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';
import { checkDuplicatePlateWarning, checkDuplicateVin } from './vehicles.js';

// PATCH /v1/vehicles/:id (F-OFF-106). RLS vehicles_update enforces
// tenant ownership (created_by_tenant_id OR certified_by_tenant_id);
// cross-tenant write falls out as P2025 → 404 via the shared error
// handler (RLS-as-404). BR-005 (vin immutable on certified) +
// BR-008 (archived blocked) checked in app-layer for clear 422 codes.

const EDITABLE_KEYS = [
  'vin',
  'plate',
  'plateCountry',
  'make',
  'model',
  'version',
  'year',
  'registrationDate',
  'vehicleType',
  'fuelType',
  'engineDisplacement',
  'powerKw',
  'color',
] as const;

const vehicleUpdateRoutes: FastifyPluginAsync = async (app) => {
  app.patch(
    '/v1/vehicles/:id',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const body = UpdateVehicleSchema.parse(request.body);
      const tenantId = request.tenantId!;
      const cognitoSub = request.userId!;

      return app.withContext({ tenantId }, async (tx) => {
        const user = await tx.user.findUniqueOrThrow({
          where: { cognitoSub },
          select: { id: true, locationId: true },
        });

        const existing = await tx.vehicle.findUniqueOrThrow({
          where: { id },
          select: { vin: true, plate: true, plateCountry: true, status: true },
        });

        if (existing.status === 'archived') {
          throw businessError(
            'vehicle.modification.archived',
            422,
            'Veicolo archiviato: non modificabile.',
          );
        }

        if (
          body.vin !== undefined &&
          body.vin !== existing.vin &&
          existing.status === 'certified'
        ) {
          throw businessError(
            'vehicle.modification.vin_immutable',
            422,
            'VIN non modificabile su veicolo certificato.',
          );
        }

        if (body.vin !== undefined && body.vin !== existing.vin) {
          if (!body.forceNonstandardVin && !validateVinIso3779(body.vin)) {
            throw businessError(
              'vehicle.creation.invalid_vin_checksum',
              400,
              'Il VIN non rispetta il checksum ISO 3779. Usa forceNonstandardVin=true per veicoli storici o agricoli.',
            );
          }
          await checkDuplicateVin(tx, body.vin);
        }

        const newPlate = body.plate ?? existing.plate;
        const newPlateCountry = body.plateCountry ?? existing.plateCountry;
        if (newPlate !== existing.plate || newPlateCountry !== existing.plateCountry) {
          await checkDuplicatePlateWarning(tx, newPlate, newPlateCountry, body.force, id);
        }

        // Build update payload: only fields the caller sent. Override flags
        // (force, forceNonstandardVin) are NOT persisted.
        const data: Record<string, unknown> = {};
        for (const k of EDITABLE_KEYS) {
          const value = (body as Record<string, unknown>)[k];
          if (value !== undefined) {
            data[k] =
              k === 'registrationDate' && typeof value === 'string' ? new Date(value) : value;
          }
        }

        await tx.vehicle.update({ where: { id }, data });

        await recordVehicleAccess({
          tx,
          vehicleId: id,
          tenantId,
          userId: user.id,
          ...(user.locationId ? { locationId: user.locationId } : {}),
          action: 'update',
          ipAddress: request.ip,
          log: request.log,
        });

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

export default vehicleUpdateRoutes;
