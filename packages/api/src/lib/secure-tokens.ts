import { createHash, randomUUID } from 'node:crypto';

export function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

// Email verification token: single UUID, 36 chars with dashes.
// Used by F-CLI-001 customer signup verify-email flow.
export function generateVerificationToken(): { plaintext: string; hash: string } {
  const plaintext = randomUUID();
  return { plaintext, hash: hashToken(plaintext) };
}

// Invitation token: legacy format preserved for URL aesthetic parity
// with pre-PR2 magic-link URLs. randomUUID() (36 chars) + randomUUID()
// without dashes (32 chars) = 68 chars total.
export function generateInvitationToken(): { plaintext: string; hash: string } {
  const plaintext = randomUUID() + randomUUID().replace(/-/g, '');
  return { plaintext, hash: hashToken(plaintext) };
}
