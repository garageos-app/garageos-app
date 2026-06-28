// Unit tests for createInternalInvitation helper.
//
// Tests the token generation, invitation.create call shape, and P2002 error
// mapping. Does NOT mock generateInvitationToken — we test real token
// behaviour so we can assert hash(plaintext) === storedHash.

import { describe, it, expect, vi } from 'vitest';
import { Prisma } from '@garageos/database';
import { createInternalInvitation, INVITATION_TTL_MS } from '../../src/lib/invitation-creation.js';
import { hashToken } from '../../src/lib/secure-tokens.js';
import type { InvitationAdminRow } from '../../src/lib/dtos/invitation.js';

// ─── Constants ────────────────────────────────────────────────────────────────
const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const INVITATION_ID = '33333333-3333-4333-8333-333333333333';
const LOCATION_ID = '22222222-2222-4222-8222-222222222222';

const BASE_INPUT = {
  tenantId: TENANT_ID,
  targetEmail: 'mario@example.com',
  firstName: 'Mario',
  lastName: 'Rossi',
  role: 'super_admin' as const,
  locationId: LOCATION_ID,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function makeInvitationRow(overrides: Partial<InvitationAdminRow> = {}): InvitationAdminRow {
  return {
    id: INVITATION_ID,
    targetEmail: 'mario@example.com',
    firstName: 'Mario',
    lastName: 'Rossi',
    role: 'super_admin',
    locationId: LOCATION_ID,
    expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
    acceptedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

// Builds a minimal tx stub whose invitation.create is driven by the given
// implementation. The unknown cast avoids threading the full PrismaClient
// type through the test, matching the FakePrisma pattern in route unit tests.
function makeTx(impl: () => Promise<InvitationAdminRow>) {
  return {
    invitation: {
      create: vi.fn().mockImplementation(impl),
    },
  } as unknown as Parameters<typeof createInternalInvitation>[0];
}

// ─── Tests ────────────────────────────────────────────────────────────────────
describe('createInternalInvitation', () => {
  it('calls tx.invitation.create with correct data and returns invitation + 68-char tokenPlaintext whose hash matches', async () => {
    const row = makeInvitationRow();
    const tx = makeTx(async () => row);
    const before = Date.now();

    const { invitation, tokenPlaintext } = await createInternalInvitation(tx, BASE_INPUT);

    // Return value: the invitation row and the plaintext token
    expect(invitation).toBe(row);

    // tokenPlaintext: randomUUID() (36 chars) + randomUUID().replace(/-/g,'') (32 chars) = 68
    expect(tokenPlaintext).toHaveLength(68);

    // Exactly one DB write
    expect(tx.invitation.create).toHaveBeenCalledOnce();

    const callArg = (tx.invitation.create as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      data: {
        tenantId: string;
        invitationType: string;
        targetEmail: string;
        firstName: string;
        lastName: string;
        role: string;
        locationId: string | null;
        tokenHash: string;
        expiresAt: Date;
      };
    };
    const { tokenHash, expiresAt, ...coreFields } = callArg.data;

    // tokenHash must be a 64-hex SHA-256 digest
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);

    // The hash of the returned plaintext must equal the hash that was stored
    expect(hashToken(tokenPlaintext)).toBe(tokenHash);

    // expiresAt must be ≈ now + 7 days
    const after = Date.now();
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + INVITATION_TTL_MS);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(after + INVITATION_TTL_MS);

    // Core fields are passed verbatim from input; invitationType is always 'internal_user'
    expect(coreFields).toEqual({
      tenantId: TENANT_ID,
      invitationType: 'internal_user',
      targetEmail: 'mario@example.com',
      firstName: 'Mario',
      lastName: 'Rossi',
      role: 'super_admin',
      locationId: LOCATION_ID,
    });
  });

  it('passes locationId:null through to invitation.create', async () => {
    const row = makeInvitationRow({ locationId: null });
    const tx = makeTx(async () => row);

    await createInternalInvitation(tx, { ...BASE_INPUT, locationId: null });

    const callArg = (tx.invitation.create as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      data: { locationId: string | null };
    };
    expect(callArg.data.locationId).toBeNull();
  });

  it('throws businessError user.invitation.duplicate_pending (409) on P2002', async () => {
    const tx = makeTx(async () => {
      throw new Prisma.PrismaClientKnownRequestError('unique violation', {
        code: 'P2002',
        clientVersion: 'test',
      });
    });

    await expect(createInternalInvitation(tx, BASE_INPUT)).rejects.toMatchObject({
      name: 'user.invitation.duplicate_pending',
      statusCode: 409,
    });
  });

  it('re-throws non-P2002 errors unchanged', async () => {
    const originalError = new Error('unexpected DB error');
    const tx = makeTx(async () => {
      throw originalError;
    });

    await expect(createInternalInvitation(tx, BASE_INPUT)).rejects.toBe(originalError);
  });
});
