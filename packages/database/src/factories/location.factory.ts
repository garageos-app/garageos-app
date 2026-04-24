import { randomUUID } from 'node:crypto';

import { Factory } from 'fishery';

import { prisma } from '../client.js';
import type { Prisma } from '../../prisma/generated/prisma/client/client.js';

// Requires `tenantId` to be passed explicitly when building/creating —
// a Location without its Tenant is not a valid fixture. Fishery throws on
// `prisma.location.create` if tenantId is missing, which surfaces the
// mistake loudly rather than silently producing invalid data.

export const LocationFactory = Factory.define<Prisma.LocationUncheckedCreateInput>(
  ({ sequence, onCreate }) => {
    onCreate(async (data) => {
      await prisma.location.create({ data });
      return data;
    });

    return {
      id: randomUUID(),
      tenantId: randomUUID(), // overridden at call site with real tenantId
      name: `Sede ${sequence}`,
      addressLine: 'Via Test 1',
      city: 'Milano',
      province: 'MI',
      postalCode: '20100',
      country: 'IT',
      isPrimary: true,
      status: 'active',
    };
  },
);

export const secondaryLocation = LocationFactory.params({ isPrimary: false });
