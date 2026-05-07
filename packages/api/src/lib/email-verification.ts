import { createHash, randomUUID } from 'node:crypto';

// 24-hour TTL for verify-email tokens. After expiry the token row is
// inert in DB; resend route (auth-resend-verification.ts) issues a new one.
export const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

export function generateVerificationToken(): { plaintext: string; hash: string } {
  const plaintext = randomUUID();
  return { plaintext, hash: hashToken(plaintext) };
}

export function buildVerificationUrl(baseUrl: string, token: string): string {
  return `${baseUrl}?token=${encodeURIComponent(token)}`;
}
