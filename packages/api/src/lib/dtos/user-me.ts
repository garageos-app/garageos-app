import type { Prisma } from '@garageos/database';

import { keyToPresignedUrl } from '../avatar-presign.js';

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
  // Names for the officina brand strip (F-OFF-007 follow-up): the web
  // TopBar shows "Officina <businessName> · Sede <name>". location is null
  // for users without an assigned sede.
  tenant: { select: { businessName: true } },
  location: { select: { name: true, city: true } },
} as const satisfies Prisma.UserSelect;

export type UserMeDto = Prisma.UserGetPayload<{ select: typeof USER_ME_SELECT }>;

// Wire-format DTO shape: `avatarUrl` semantics changes from DB-stored
// S3 key to a fully-resolved presigned GET URL (or null). This is the
// shape returned by every endpoint that exposes /users/me data.
export type UserMeWireDto = Omit<UserMeDto, 'avatarUrl'> & { avatarUrl: string | null };

// serializeUserMe transforms the DB row into the wire format by
// resolving avatarUrl (which is an S3 object key) into a presigned
// 15-min GET URL. Null when the user has no avatar set.
//
// Called by GET /v1/users/me, PATCH /v1/users/me, and
// POST /v1/users/me/avatar/confirm — anywhere the wire DTO is emitted.
export async function serializeUserMe(row: UserMeDto): Promise<UserMeWireDto> {
  const url = row.avatarUrl ? await keyToPresignedUrl(row.avatarUrl) : null;
  return { ...row, avatarUrl: url };
}
