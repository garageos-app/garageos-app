import { randomUUID } from 'node:crypto';

import { Factory } from 'fishery';

import { prisma } from '../client.js';
import type { Prisma } from '../../prisma/generated/prisma/client/client.js';

// Caller must pass `tenantId` and `customerId`. The row itself is the
// enforcement for BR-151 (customer PII visibility to a tenant) — its
// existence is what opens the write path in the `customers_write_by_related_tenant`
// RLS policy.

export const CustomerTenantRelationFactory =
  Factory.define<Prisma.CustomerTenantRelationUncheckedCreateInput>(({ onCreate }) => {
    onCreate(async (data) => {
      await prisma.customerTenantRelation.create({ data });
      return data;
    });

    return {
      id: randomUUID(),
      tenantId: randomUUID(),
      customerId: randomUUID(),
      interventionCount: 0,
      customerDeleted: false,
    };
  });
