// Pure helper: generate token + create an internal_user invitation row.
//
// Extracted from admin-tenants-create.ts and users-invitations-create.ts so
// that both callers (and the regenerate-invitation endpoint) share a single,
// tested implementation.
//
// Email send and audit log remain in the callers — they differ per call site:
//   - admin-tenants-create.ts: actorType:'system', no inviter lookup
//   - users-invitations-create.ts: actorType:'user', looks up inviter name
//
// tx must be a PrismaClient obtained from a withContext({role:'admin'}) callback
// (the plugin types the callback arg as PrismaClient, not Prisma.TransactionClient).

import type { PrismaClient } from '@garageos/database';
import { Prisma } from '@garageos/database';
import { businessError } from './business-error.js';
import { generateInvitationToken } from './secure-tokens.js';
import { INVITATION_ADMIN_SELECT } from './dtos/invitation.js';
import type { InvitationAdminRow } from './dtos/invitation.js';

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface CreateInternalInvitationInput {
  tenantId: string;
  targetEmail: string;
  firstName: string;
  lastName: string;
  role: 'super_admin' | 'mechanic';
  locationId: string | null;
}

/**
 * Generate a magic-link token and insert an `internal_user` invitation row.
 *
 * On a P2002 unique-index violation (partial index
 * `uq_invitations_pending_internal`) the caller receives a business error with
 * code `user.invitation.duplicate_pending` / HTTP 409, matching BR-206.
 * All other DB errors are re-thrown unchanged.
 *
 * @returns `{ invitation, tokenPlaintext }` — the DB row (INVITATION_ADMIN_SELECT
 *   shape) and the raw token for building the magic-link URL. The plaintext
 *   token must never be stored in the DB or returned in an API response.
 */
export async function createInternalInvitation(
  tx: PrismaClient,
  input: CreateInternalInvitationInput,
): Promise<{ invitation: InvitationAdminRow; tokenPlaintext: string }> {
  const { plaintext, hash: tokenHash } = generateInvitationToken();
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

  let invitation: InvitationAdminRow;
  try {
    invitation = await tx.invitation.create({
      data: {
        tenantId: input.tenantId,
        invitationType: 'internal_user',
        targetEmail: input.targetEmail,
        firstName: input.firstName,
        lastName: input.lastName,
        role: input.role,
        locationId: input.locationId,
        tokenHash,
        expiresAt,
      },
      select: INVITATION_ADMIN_SELECT,
    });
  } catch (err) {
    // BR-206: partial unique index uq_invitations_pending_internal prevents
    // duplicate pending internal_user invitations for the same (tenant, email).
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw businessError(
        'user.invitation.duplicate_pending',
        409,
        'Esiste già un invito pendente per questa email.',
      );
    }
    throw err;
  }

  return { invitation, tokenPlaintext: plaintext };
}
