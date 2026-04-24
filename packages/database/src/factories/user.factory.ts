import { randomUUID } from 'node:crypto';

import { Factory } from 'fishery';

import { prisma } from '../client.js';
import type { Prisma } from '../../prisma/generated/prisma/client/client.js';

// Caller must pass `tenantId`. `locationId` is required for mechanics
// (BR-204) but optional for super_admins — callers set it explicitly.

export const UserFactory = Factory.define<Prisma.UserUncheckedCreateInput>(
  ({ sequence, onCreate }) => {
    onCreate(async (data) => {
      await prisma.user.create({ data });
      return data;
    });

    return {
      id: randomUUID(),
      tenantId: randomUUID(),
      locationId: null,
      cognitoSub: `cognito-test-${sequence}`,
      email: `user-${sequence}@test.local`,
      firstName: 'Mario',
      lastName: 'Rossi',
      role: 'super_admin',
      status: 'active',
    };
  },
);

export const mechanicUser = UserFactory.params({ role: 'mechanic' });
export const invitedUser = UserFactory.params({ status: 'invited' });
