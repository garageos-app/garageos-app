import { randomUUID } from 'node:crypto';

import { Factory } from 'fishery';

import { prisma } from '../client.js';
import type { Prisma } from '../../prisma/generated/prisma/client/client.js';

// Caller must pass `vehicleId` and `customerId` — an ownership without
// the vehicle or customer it binds is not a valid fixture. Default
// `endedAt=null` means "currently active"; use `endedOwnership` trait
// (or override at call site) to build historical rows.

export const VehicleOwnershipFactory = Factory.define<Prisma.VehicleOwnershipUncheckedCreateInput>(
  ({ onCreate }) => {
    onCreate(async (data) => {
      await prisma.vehicleOwnership.create({ data });
      return data;
    });

    return {
      id: randomUUID(),
      vehicleId: randomUUID(),
      customerId: randomUUID(),
      startedAt: new Date(),
      endedAt: null,
    };
  },
);

// Closed ownership — already transferred away. BR-040 partial unique
// index only looks at rows with ended_at IS NULL, so this trait is safe
// to stack with active ownerships on the same vehicle.
export const endedOwnership = VehicleOwnershipFactory.params({
  startedAt: new Date('2024-01-01T00:00:00Z'),
  endedAt: new Date('2025-01-01T00:00:00Z'),
});
