import { describe, expect, it } from 'vitest';

import {
  generateInvitationToken,
  generateVerificationToken,
  hashToken,
} from '../../../src/lib/secure-tokens.js';

describe('secure-tokens.hashToken', () => {
  it('produces a stable 64-char SHA-256 hex string', () => {
    const out = hashToken('hello');
    expect(out).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    expect(out).toHaveLength(64);
    expect(out).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic — same input → same output', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
  });

  it('different inputs yield different hashes', () => {
    expect(hashToken('a')).not.toBe(hashToken('b'));
  });
});

describe('secure-tokens.generateInvitationToken', () => {
  it('returns plaintext + hash where hashToken(plaintext) === hash', () => {
    const { plaintext, hash } = generateInvitationToken();
    expect(hashToken(plaintext)).toBe(hash);
  });

  it('plaintext has the legacy invitation format (~68 chars, hex+dashes)', () => {
    const { plaintext } = generateInvitationToken();
    // randomUUID() = 36 chars (8-4-4-4-12 with 4 dashes) + randomUUID().replace('-','') = 32 chars
    // total = 68 chars
    expect(plaintext).toHaveLength(68);
    expect(plaintext).toMatch(/^[0-9a-f-]+$/);
  });

  it('two invocations produce different plaintexts (uniqueness)', () => {
    const a = generateInvitationToken();
    const b = generateInvitationToken();
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe('secure-tokens.generateVerificationToken (email-verification token)', () => {
  it('plaintext is a single UUID string (36 chars with dashes)', () => {
    const { plaintext, hash } = generateVerificationToken();
    expect(plaintext).toHaveLength(36);
    expect(plaintext).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(hashToken(plaintext)).toBe(hash);
  });
});
