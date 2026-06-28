// Platform-admin DTO for Tenant rows in GET /v1/admin/tenants.
// Mirrors the pattern in packages/api/src/lib/dtos/invitation.ts:
//   - Prisma SELECT const using `satisfies Prisma.XSelect`
//   - Explicit wire-format type to avoid TS deep-enum inference issues (TS2883)
//   - Pure serializer function + pure owner-status derivation (unit-testable)
//
// Schema verification note: Tenant.email is `String` (non-nullable) in
// schema.prisma, not `String?`. The task brief declared `email: string | null`;
// schema wins — wire type uses `string`. Report in task-3-report.md.

import type { Prisma } from '@garageos/database';

// ─── Tenant SELECT ────────────────────────────────────────────────────────────

export const TENANT_ADMIN_LIST_SELECT = {
  id: true,
  businessName: true,
  vatNumber: true,
  email: true,
  status: true,
  createdAt: true,
} as const satisfies Prisma.TenantSelect;

export type TenantAdminListRow = Prisma.TenantGetPayload<{
  select: typeof TENANT_ADMIN_LIST_SELECT;
}>;

// ─── Invitation SELECT (owner derivation) ─────────────────────────────────────

export const INVITATION_OWNER_SELECT = {
  tenantId: true,
  targetEmail: true,
  acceptedAt: true,
  expiresAt: true,
  createdAt: true,
} as const satisfies Prisma.InvitationSelect;

export type InvitationOwnerRow = Prisma.InvitationGetPayload<{
  select: typeof INVITATION_OWNER_SELECT;
}>;

// ─── Wire types ───────────────────────────────────────────────────────────────

export type TenantAdminInvitationStatus = 'pending' | 'accepted' | 'expired';

// Explicit wire-format type avoids deep-enum inference issues (TS2883).
// TenantStatus = "active" | "suspended" | "pending" | "cancelled" in Prisma 7
// (const-object pattern), so the union is structurally equivalent.
export interface TenantAdminListItem {
  id: string;
  businessName: string;
  vatNumber: string;
  email: string;
  status: 'active' | 'suspended' | 'pending' | 'cancelled';
  createdAt: string; // ISO-8601
  owner: { email: string; invitationStatus: TenantAdminInvitationStatus } | null;
}

// ─── Owner-status derivation ──────────────────────────────────────────────────
// Pure function: accepts `now` as a parameter so unit tests can control time
// and the route can snapshot once per request (no repeated Date.now() calls).

export function deriveOwnerStatus(
  invitation: InvitationOwnerRow,
  now: Date,
): TenantAdminInvitationStatus {
  if (invitation.acceptedAt !== null) return 'accepted';
  if (invitation.expiresAt < now) return 'expired';
  return 'pending';
}

// ─── Serializer ───────────────────────────────────────────────────────────────

export function serializeTenantAdminListItem(
  row: TenantAdminListRow,
  ownerInvitation: InvitationOwnerRow | null,
  now: Date,
): TenantAdminListItem {
  return {
    id: row.id,
    businessName: row.businessName,
    vatNumber: row.vatNumber,
    email: row.email,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    owner:
      ownerInvitation === null
        ? null
        : {
            email: ownerInvitation.targetEmail,
            invitationStatus: deriveOwnerStatus(ownerInvitation, now),
          },
  };
}
