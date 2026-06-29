// Unit tests for adminTenantRateLimitKey — the rate-limit key generator for
// platform-admin tenant mutation routes. Pure function; no network, no DB.
// Run locally with: pnpm --filter @garageos/api test:unit

import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';

import { adminTenantRateLimitKey } from '../../../src/lib/admin-tenant-rate-limit.js';

// ─── Test helpers ─────────────────────────────────────────────────────────────

// Build a minimal fake FastifyRequest with only the fields the helper reads.
function makeRequest(overrides: { authorization?: string; ip?: string }): FastifyRequest {
  return {
    headers: { authorization: overrides.authorization },
    ip: overrides.ip ?? '127.0.0.1',
  } as unknown as FastifyRequest;
}

// Build a Bearer token whose payload segment is a base64url-encoded JSON object.
// The header and signature are dummies — the helper does not verify the signature.
function makeBearer(payload: Record<string, unknown>): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `Bearer eyJhbGciOiJSUzI1NiJ9.${payloadB64}.dummy-signature`;
}

const ADMIN_SUB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('adminTenantRateLimitKey', () => {
  // (a) Valid Bearer token with a non-empty sub → keyed on sub
  it('returns admin-tenant:<sub> for a valid Bearer token with a sub claim', () => {
    const req = makeRequest({ authorization: makeBearer({ sub: ADMIN_SUB }) });
    expect(adminTenantRateLimitKey(req)).toBe(`admin-tenant:${ADMIN_SUB}`);
  });

  it('uses the sub as-is (preserves UUID format)', () => {
    const sub = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const req = makeRequest({ authorization: makeBearer({ sub }) });
    expect(adminTenantRateLimitKey(req)).toBe(`admin-tenant:${sub}`);
  });

  // (b) Missing header → IP fallback
  it('returns admin-tenant-ip:<ip> when Authorization header is absent', () => {
    const req = makeRequest({ ip: '1.2.3.4' });
    expect(adminTenantRateLimitKey(req)).toBe('admin-tenant-ip:1.2.3.4');
  });

  // (c) Malformed token cases → IP fallback, never throws

  it('returns admin-tenant-ip:<ip> when Authorization does not start with "Bearer "', () => {
    const req = makeRequest({ authorization: 'Basic abc123', ip: '1.2.3.4' });
    expect(adminTenantRateLimitKey(req)).toBe('admin-tenant-ip:1.2.3.4');
  });

  it('returns admin-tenant-ip:<ip> for a Bearer token with only one segment (not a JWT)', () => {
    const req = makeRequest({ authorization: 'Bearer notajwt', ip: '2.3.4.5' });
    expect(adminTenantRateLimitKey(req)).toBe('admin-tenant-ip:2.3.4.5');
  });

  it('returns admin-tenant-ip:<ip> for invalid base64url in the payload segment', () => {
    // Characters outside the base64url alphabet cause Buffer.from to produce
    // garbage, which then fails JSON.parse → caught, returns IP fallback.
    const req = makeRequest({ authorization: 'Bearer header.!@#$%.sig', ip: '3.4.5.6' });
    expect(adminTenantRateLimitKey(req)).toBe('admin-tenant-ip:3.4.5.6');
  });

  it('returns admin-tenant-ip:<ip> when the payload is valid JSON but has no sub claim', () => {
    const req = makeRequest({
      authorization: makeBearer({ email: 'admin@garageos.it', aud: 'test' }),
      ip: '4.5.6.7',
    });
    expect(adminTenantRateLimitKey(req)).toBe('admin-tenant-ip:4.5.6.7');
  });

  it('returns admin-tenant-ip:<ip> when sub is an empty string', () => {
    const req = makeRequest({ authorization: makeBearer({ sub: '' }), ip: '5.6.7.8' });
    expect(adminTenantRateLimitKey(req)).toBe('admin-tenant-ip:5.6.7.8');
  });

  it('returns admin-tenant-ip:<ip> when sub is a non-string type (number)', () => {
    const req = makeRequest({ authorization: makeBearer({ sub: 42 }), ip: '6.7.8.9' });
    expect(adminTenantRateLimitKey(req)).toBe('admin-tenant-ip:6.7.8.9');
  });

  it('never throws even for completely invalid input — always returns a string', () => {
    // A request object that throws when reading authorization should be caught.
    const badRequest = {
      get headers() {
        throw new Error('unexpected access');
      },
      ip: '9.9.9.9',
    };
    expect(() => adminTenantRateLimitKey(badRequest as unknown as FastifyRequest)).not.toThrow();
    expect(adminTenantRateLimitKey(badRequest as unknown as FastifyRequest)).toBe(
      'admin-tenant-ip:9.9.9.9',
    );
  });
});
