// Backward-compat shim — token helpers moved to secure-tokens.ts in PR2.
// New code SHOULD import directly from './secure-tokens.js'.
export { hashToken, generateVerificationToken } from './secure-tokens.js';

// 24-hour TTL for verify-email tokens. After expiry the token row is
// inert in DB; resend route (auth-resend-verification.ts) issues a new one.
export const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export function buildVerificationUrl(baseUrl: string, token: string): string {
  return `${baseUrl}?token=${encodeURIComponent(token)}`;
}
