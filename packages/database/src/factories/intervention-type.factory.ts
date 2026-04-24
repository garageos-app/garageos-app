import { randomUUID } from 'node:crypto';

import { Factory } from 'fishery';

import { prisma } from '../client.js';
import type { Prisma } from '../../prisma/generated/prisma/client/client.js';

// InterventionType supports both system rows (tenant_id NULL) and per-tenant
// custom rows. Default factory output is a system row because existing
// integration tests rely on the 12 seeded system types; caller overrides
// `tenantId` for tenant-specific custom types.

export const InterventionTypeFactory = Factory.define<Prisma.InterventionTypeUncheckedCreateInput>(
  ({ sequence, onCreate }) => {
    onCreate(async (data) => {
      await prisma.interventionType.create({ data });
      return data;
    });

    return {
      id: randomUUID(),
      tenantId: null,
      code: `TEST_TYPE_${sequence}`,
      nameIt: `Tipo Intervento ${sequence}`,
      category: 'maintenance',
      suggestsDeadline: false,
      active: true,
    };
  },
);
