import { randomUUID } from 'node:crypto';

import { Factory } from 'fishery';

import { prisma } from '../client.js';
import type { Prisma } from '../../prisma/generated/prisma/client/client.js';

// All FKs (tenantId, locationId, userId, vehicleId, interventionTypeId) must
// be set explicitly by the caller — an intervention without its parent
// entities is not a valid fixture. Factory defaults are placeholder UUIDs
// intended to fail loudly at DB time if left unset.

export const InterventionFactory = Factory.define<Prisma.InterventionUncheckedCreateInput>(
  ({ sequence, onCreate }) => {
    onCreate(async (data) => {
      await prisma.intervention.create({ data });
      return data;
    });

    const today = new Date().toISOString().slice(0, 10);

    return {
      id: randomUUID(),
      tenantId: randomUUID(),
      locationId: randomUUID(),
      userId: randomUUID(),
      vehicleId: randomUUID(),
      interventionTypeId: randomUUID(),
      interventionDate: new Date(today),
      odometerKm: 10_000 + sequence,
      description: `Intervento di test #${sequence}`,
      partsReplaced: [],
      status: 'active',
      kmAnomaly: false,
    };
  },
);

export const cancelledIntervention = InterventionFactory.params({ status: 'cancelled' });
export const disputedIntervention = InterventionFactory.params({ status: 'disputed' });
