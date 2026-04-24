import { randomUUID } from 'node:crypto';

import { Factory } from 'fishery';

import { prisma } from '../client.js';
import type { Prisma } from '../../prisma/generated/prisma/client/client.js';

// Factory output uses `UncheckedCreateInput` so FKs are plain scalar UUIDs
// and no `{ connect: ... }` nesting is needed. Sequences guarantee unique
// `vatNumber` / `email` within a single test run.

export const TenantFactory = Factory.define<Prisma.TenantUncheckedCreateInput>(
  ({ sequence, onCreate }) => {
    onCreate(async (data) => {
      await prisma.tenant.create({ data });
      return data;
    });

    return {
      id: randomUUID(),
      businessName: `Officina Test ${sequence}`,
      // 11-digit VAT — zero-padded sequence satisfies VatNumberSchema regex.
      vatNumber: String(sequence).padStart(11, '0'),
      email: `tenant-${sequence}@test.local`,
      phone: null,
      addressLine: 'Via Test 1',
      city: 'Milano',
      province: 'MI',
      postalCode: '20100',
      taxCode: null,
      logoUrl: null,
      status: 'active',
      billingStatus: 'manual',
      plan: 'starter',
      settings: {},
    };
  },
);

// Trait helpers keep call sites short and self-documenting. Extend on demand
// rather than up-front — add traits only when a real test needs them.
export const suspendedTenant = TenantFactory.params({ status: 'suspended' });
