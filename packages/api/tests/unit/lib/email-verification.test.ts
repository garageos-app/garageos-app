import { describe, expect, it } from 'vitest';

import {
  buildVerificationUrl,
  generateVerificationToken,
  hashToken,
  VERIFICATION_TOKEN_TTL_MS,
} from '../../../src/lib/email-verification.js';

describe('email-verification helpers', () => {
  it('hashToken produces a deterministic 64-char hex SHA-256 digest', () => {
    const a = hashToken('the-token');
    const b = hashToken('the-token');
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(hashToken('different-token')).not.toBe(a);
  });

  it('generateVerificationToken returns UUID plaintext + matching SHA-256 hash', () => {
    const { plaintext, hash } = generateVerificationToken();
    expect(plaintext).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(hash).toBe(hashToken(plaintext));
  });

  it('generateVerificationToken returns distinct tokens on consecutive calls', () => {
    const a = generateVerificationToken();
    const b = generateVerificationToken();
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.hash).not.toBe(b.hash);
  });

  it('buildVerificationUrl URL-encodes the token in the query string', () => {
    const url = buildVerificationUrl('https://app.example.com/verify-email', 'abc/def?x=1');
    expect(url).toBe('https://app.example.com/verify-email?token=abc%2Fdef%3Fx%3D1');
  });

  it('VERIFICATION_TOKEN_TTL_MS equals 24 hours', () => {
    expect(VERIFICATION_TOKEN_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});
