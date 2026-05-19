// F-OFF-004 admin-view DTO for Invitation rows. Used by
// POST /v1/users/invitations (create) and future list/detail endpoints.
// token is intentionally excluded from the serializer — the plaintext
// magic-link token must never be returned in an API response.

import type { Prisma, UserRole } from '@garageos/database';

export const INVITATION_ADMIN_SELECT = {
  id: true,
  targetEmail: true,
  firstName: true,
  lastName: true,
  role: true,
  locationId: true,
  expiresAt: true,
  acceptedAt: true,
  createdAt: true,
} as const satisfies Prisma.InvitationSelect;

export type InvitationAdminRow = Prisma.InvitationGetPayload<{
  select: typeof INVITATION_ADMIN_SELECT;
}>;

// Explicit wire-format type avoids deep-enum inference issues (TS2883).
export type InvitationAdminWireDto = {
  id: string;
  targetEmail: string;
  firstName: string | null;
  lastName: string | null;
  role: UserRole | null;
  locationId: string | null;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
};

export function serializeInvitationAdmin(row: InvitationAdminRow): InvitationAdminWireDto {
  return {
    id: row.id,
    targetEmail: row.targetEmail,
    firstName: row.firstName,
    lastName: row.lastName,
    role: row.role,
    locationId: row.locationId,
    expiresAt: row.expiresAt.toISOString(),
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

// Public-view shape for GET /v1/invitations/:token — does NOT leak
// id, locationId, createdAt, acceptedAt. Just what the accept form needs.
export interface InvitationPublicView {
  targetEmail: string;
  firstName: string;
  lastName: string;
  role: 'super_admin' | 'mechanic';
  locationName: string | null;
  tenantName: string;
  expiresAt: string;
}
