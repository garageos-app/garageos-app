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
  phone: true,
  status: true,
  createdAt: true,
  // Tenant name for the officina brand strip (F-OFF-007 follow-up).
  tenant: { select: { businessName: true } },
} as const satisfies Prisma.UserSelect;

export type UserMeDto = Prisma.UserGetPayload<{ select: typeof USER_ME_SELECT }>;

export type UserMeWireDto = UserMeDto;

// serializeUserMe previously resolved an S3 avatar key to a presigned
// URL. Avatar upload was removed (PR2); the function stays as a stable
// pass-through so /users/me callers need no signature change.
export async function serializeUserMe(row: UserMeDto): Promise<UserMeWireDto> {
  return row;
}
