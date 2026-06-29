// Unit tests for serializeTenantAdminListItem / deriveOwnerStatus.
// Pure functions — no network, no DB.
// Run locally with: pnpm --filter @garageos/api test:unit

import { describe, expect, it } from 'vitest';

import {
  deriveOwnerStatus,
  serializeTenantAdminListItem,
  type InvitationOwnerRow,
  type TenantAdminListRow,
} from '../../../src/lib/dtos/tenant-admin.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = new Date('2026-06-29T12:00:00.000Z');
const FUTURE = new Date('2026-07-06T12:00:00.000Z'); // expiresAt > NOW → pending
const PAST = new Date('2026-06-22T12:00:00.000Z'); // expiresAt < NOW → expired

function makeInvitation(overrides: Partial<InvitationOwnerRow> = {}): InvitationOwnerRow {
  return {
    tenantId: 'tenant-id',
    targetEmail: 'owner@test.it',
    acceptedAt: null,
    expiresAt: FUTURE,
    ...overrides,
  };
}

// TenantStatus in Prisma 7 is a const-object enum whose type resolves to
// the union "active" | "suspended" | "pending" | "cancelled" — string
// literals are directly assignable.
function makeTenantRow(overrides: Partial<TenantAdminListRow> = {}): TenantAdminListRow {
  return {
    id: 'tenant-id',
    businessName: 'Test Officina SRL',
    vatNumber: '12345678901',
    email: 'officina@test.it',
    status: 'active',
    createdAt: NOW,
    ...overrides,
  } as TenantAdminListRow;
}

// ─── deriveOwnerStatus ────────────────────────────────────────────────────────

describe('deriveOwnerStatus', () => {
  it('returns "accepted" when acceptedAt is set, regardless of expiresAt', () => {
    const inv = makeInvitation({ acceptedAt: PAST, expiresAt: PAST });
    expect(deriveOwnerStatus(inv, NOW)).toBe('accepted');
  });

  it('returns "accepted" even when expiresAt is in the future and acceptedAt is set', () => {
    const inv = makeInvitation({ acceptedAt: PAST, expiresAt: FUTURE });
    expect(deriveOwnerStatus(inv, NOW)).toBe('accepted');
  });

  it('returns "expired" when acceptedAt is null and expiresAt < now', () => {
    const inv = makeInvitation({ acceptedAt: null, expiresAt: PAST });
    expect(deriveOwnerStatus(inv, NOW)).toBe('expired');
  });

  it('returns "pending" when acceptedAt is null and expiresAt > now', () => {
    const inv = makeInvitation({ acceptedAt: null, expiresAt: FUTURE });
    expect(deriveOwnerStatus(inv, NOW)).toBe('pending');
  });

  it('returns "pending" when expiresAt === now (boundary: strictly less-than check)', () => {
    // expiresAt === now: `expiresAt < now` is false → not yet expired
    const inv = makeInvitation({ acceptedAt: null, expiresAt: NOW });
    expect(deriveOwnerStatus(inv, NOW)).toBe('pending');
  });
});

// ─── serializeTenantAdminListItem ─────────────────────────────────────────────

describe('serializeTenantAdminListItem', () => {
  it('returns owner: null when no invitation is provided (legacy tenant with no invitation)', () => {
    const result = serializeTenantAdminListItem(makeTenantRow(), null, NOW);
    expect(result.owner).toBeNull();
  });

  it('serializes a pending invitation correctly', () => {
    const result = serializeTenantAdminListItem(
      makeTenantRow(),
      makeInvitation({ acceptedAt: null, expiresAt: FUTURE }),
      NOW,
    );
    expect(result.owner).toEqual({ email: 'owner@test.it', invitationStatus: 'pending' });
  });

  it('serializes an accepted invitation correctly', () => {
    const result = serializeTenantAdminListItem(
      makeTenantRow(),
      makeInvitation({ acceptedAt: PAST, expiresAt: FUTURE }),
      NOW,
    );
    expect(result.owner).toEqual({ email: 'owner@test.it', invitationStatus: 'accepted' });
  });

  it('serializes an expired invitation correctly', () => {
    const result = serializeTenantAdminListItem(
      makeTenantRow(),
      makeInvitation({ acceptedAt: null, expiresAt: PAST }),
      NOW,
    );
    expect(result.owner).toEqual({ email: 'owner@test.it', invitationStatus: 'expired' });
  });

  it('serializes createdAt as an ISO-8601 string', () => {
    const result = serializeTenantAdminListItem(makeTenantRow(), null, NOW);
    expect(result.createdAt).toBe('2026-06-29T12:00:00.000Z');
    // Must be a valid ISO string parseable back to the same timestamp
    expect(new Date(result.createdAt).getTime()).toBe(NOW.getTime());
  });

  it('serializes all scalar fields correctly', () => {
    const result = serializeTenantAdminListItem(makeTenantRow(), null, NOW);
    expect(result).toMatchObject({
      id: 'tenant-id',
      businessName: 'Test Officina SRL',
      vatNumber: '12345678901',
      email: 'officina@test.it',
      status: 'active',
    });
  });

  it('surfaces the invitation email in owner.email (not the tenant billing email)', () => {
    const result = serializeTenantAdminListItem(
      makeTenantRow({ email: 'billing@officina.it' }),
      makeInvitation({ targetEmail: 'owner-invite@test.it' }),
      NOW,
    );
    // owner.email comes from invitation.targetEmail, NOT from tenant.email
    expect(result.owner?.email).toBe('owner-invite@test.it');
    expect(result.email).toBe('billing@officina.it');
  });
});
