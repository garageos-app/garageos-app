import type { Prisma } from '@garageos/database';

// Shared select for GET /v1/users/me + PATCH /v1/users/me response.
// Centralizing the projection eliminates drift between the two
// handlers. Field set choice rationale: same as the original GET
// handler — omits cognitoSub (security), deletedAt/updatedAt (internal
// churn), lastLoginAt (out of scope).
export const USER_ME_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  role: true,
  tenantId: true,
  locationId: true,
  avatarUrl: true,
  phone: true,
  status: true,
  createdAt: true,
} as const satisfies Prisma.UserSelect;

export type UserMeDto = Prisma.UserGetPayload<{ select: typeof USER_ME_SELECT }>;
