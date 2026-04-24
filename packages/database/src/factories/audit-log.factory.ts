import { randomUUID } from 'node:crypto';

import { Factory } from 'fishery';

import { prisma } from '../client.js';
import type { Prisma } from '../../prisma/generated/prisma/client/client.js';

// `entityType` + `entityId` are the audited target (denormalized so the
// audit table does not need FKs — BR-283 keeps audit rows around even
// after the referenced row is deleted). `tenantId` is nullable because
// system-level actions (cross-tenant admin ops) have no tenant scope.

export const AuditLogFactory = Factory.define<Prisma.AuditLogUncheckedCreateInput>(
  ({ sequence, onCreate }) => {
    onCreate(async (data) => {
      await prisma.auditLog.create({ data });
      return data;
    });

    return {
      id: randomUUID(),
      tenantId: null,
      actorType: 'system',
      actorId: null,
      action: `test_action_${sequence}`,
      entityType: 'Tenant',
      entityId: randomUUID(),
      metadata: {},
    };
  },
);
