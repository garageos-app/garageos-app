import { UpdateVehicleSchema } from '@garageos/database';
import type { FastifyPluginAsync } from 'fastify';

import {
  idParamSchema,
  vehicleDetailSelect,
  vehicleOwnershipSelect,
} from '../../lib/vehicle-shared.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

// PATCH /v1/vehicles/:id (F-OFF-106). Skeleton — BR-005/008/151 +
// access_log + dup checks land in the next tasks via TDD.

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

void vehicleOwnershipSelect; // referenced from vehicleDetailSelect; PII wiring lands in Task 11

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

      return app.withContext({ tenantId }, async (tx) => {
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

        const reloaded = await tx.vehicle.findUniqueOrThrow({
          where: { id },
          select: vehicleDetailSelect,
        });
        const { ownerships: _drop, ...vehicleFields } = reloaded;
        void _drop;
        return { vehicle: vehicleFields, currentOwnership: null };
      });
    },
  );
};

export default vehicleUpdateRoutes;
