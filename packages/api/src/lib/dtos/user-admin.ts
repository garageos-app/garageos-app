// F-OFF-004 admin-view DTO for users. Includes admin-only fields
// (status, deletedAt, role) but never cognitoSub.

import type { Prisma, UserRole, UserStatus } from '@garageos/database';

export const USER_ADMIN_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  role: true,
  status: true,
  phone: true,
  avatarUrl: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
} as const satisfies Prisma.UserSelect;

export type UserAdminRow = Prisma.UserGetPayload<{ select: typeof USER_ADMIN_SELECT }>;

// Explicit wire-format type avoids TS2883 "cannot be named without a
// reference to deep enum path" on the inferred return type of the serializer.
export type UserAdminWireDto = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  status: UserStatus;
  phone: string | null;
  avatarUrl: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export function serializeUserAdmin(row: UserAdminRow): UserAdminWireDto {
  return {
    id: row.id,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    role: row.role,
    status: row.status,
    phone: row.phone,
    avatarUrl: row.avatarUrl,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}
