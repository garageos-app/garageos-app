import { describe, expect, it } from 'vitest';

import { parseEnv } from '../../../src/config/env.js';

// `parseEnv(source)` is the factory path — tests pass explicit snapshots
// instead of mutating process.env + re-importing, which would collide
// with the module cache and with the bootstrapping that tests/unit/setup.ts
// has already done. See src/config/env.ts for the rationale.

const valid = {
  DATABASE_URL: 'postgresql://u:p@h:5432/d',
  AWS_REGION: 'eu-central-1',
  COGNITO_OFFICINE_POOL_ID: 'eu-central-1_ABC123',
  COGNITO_OFFICINE_CLIENT_ID: 'client-abc',
  COGNITO_CLIENTI_POOL_ID: 'eu-central-1_XYZ789',
  COGNITO_CLIENTI_CLIENT_ID: 'client-xyz',
} satisfies NodeJS.ProcessEnv;

describe('parseEnv', () => {
  it('accepts a minimal valid configuration', () => {
    const parsed = parseEnv(valid);
    expect(parsed.COGNITO_OFFICINE_POOL_ID).toBe('eu-central-1_ABC123');
    expect(parsed.COGNITO_CLIENTI_POOL_ID).toBe('eu-central-1_XYZ789');
    expect(parsed.AWS_REGION).toBe('eu-central-1');
    expect(parsed.NODE_ENV).toBe('development');
    expect(parsed.PORT).toBe(3100);
  });

  it('rejects missing COGNITO_OFFICINE_POOL_ID', () => {
    const { COGNITO_OFFICINE_POOL_ID: _removed, ...rest } = valid;
    void _removed;
    expect(() => parseEnv(rest as NodeJS.ProcessEnv)).toThrow(/COGNITO_OFFICINE_POOL_ID/);
  });

  it('rejects missing AWS_REGION', () => {
    const { AWS_REGION: _removed, ...rest } = valid;
    void _removed;
    expect(() => parseEnv(rest as NodeJS.ProcessEnv)).toThrow(/AWS_REGION/);
  });

  it('rejects malformed pool id', () => {
    expect(() => parseEnv({ ...valid, COGNITO_OFFICINE_POOL_ID: 'wrong_pool_id' })).toThrow(
      /COGNITO_OFFICINE_POOL_ID/,
    );
  });

  it('rejects malformed AWS_REGION', () => {
    expect(() => parseEnv({ ...valid, AWS_REGION: 'not-a-region' })).toThrow(/AWS_REGION/);
  });

  it('rejects missing client ids', () => {
    expect(() => parseEnv({ ...valid, COGNITO_OFFICINE_CLIENT_ID: '' })).toThrow();
    expect(() => parseEnv({ ...valid, COGNITO_CLIENTI_CLIENT_ID: '' })).toThrow();
  });

  it('rejects non-postgres DATABASE_URL', () => {
    expect(() => parseEnv({ ...valid, DATABASE_URL: 'mysql://x' })).toThrow(/DATABASE_URL/);
  });

  it('accepts optional JWKS URL overrides', () => {
    const parsed = parseEnv({
      ...valid,
      COGNITO_OFFICINE_JWKS_URL_OVERRIDE: 'http://127.0.0.1:9001/officine/.well-known/jwks.json',
      COGNITO_CLIENTI_JWKS_URL_OVERRIDE: 'http://127.0.0.1:9001/clienti/.well-known/jwks.json',
    });
    expect(parsed.COGNITO_OFFICINE_JWKS_URL_OVERRIDE).toMatch(/127\.0\.0\.1/);
    expect(parsed.COGNITO_CLIENTI_JWKS_URL_OVERRIDE).toMatch(/127\.0\.0\.1/);
  });

  it('rejects non-URL JWKS override', () => {
    expect(() => parseEnv({ ...valid, COGNITO_OFFICINE_JWKS_URL_OVERRIDE: 'not-a-url' })).toThrow(
      /COGNITO_OFFICINE_JWKS_URL_OVERRIDE/,
    );
  });

  it('leaves optional overrides undefined when not supplied', () => {
    const parsed = parseEnv(valid);
    expect(parsed.COGNITO_OFFICINE_JWKS_URL_OVERRIDE).toBeUndefined();
    expect(parsed.COGNITO_CLIENTI_JWKS_URL_OVERRIDE).toBeUndefined();
  });

  // --- platform-admins Cognito pool (Slice 0, Task 4) ---
  // All three are optional so that the cognito-trigger Lambda (which reuses
  // parseEnv) does not crash on cold start before the operator populates the
  // secret — the documented #217 failure mode.

  it('accepts a valid env with NO platform-admins vars set', () => {
    // Proves optionality: if any of the three were required this would throw.
    const parsed = parseEnv(valid);
    expect(parsed.COGNITO_PLATFORM_ADMINS_POOL_ID).toBeUndefined();
    expect(parsed.COGNITO_PLATFORM_ADMINS_CLIENT_ID).toBeUndefined();
    expect(parsed.COGNITO_PLATFORM_ADMINS_JWKS_URL_OVERRIDE).toBeUndefined();
  });

  it('surfaces platform-admins vars when all three are provided', () => {
    const parsed = parseEnv({
      ...valid,
      COGNITO_PLATFORM_ADMINS_POOL_ID: 'eu-central-1_PLT999',
      COGNITO_PLATFORM_ADMINS_CLIENT_ID: 'client-plt',
      COGNITO_PLATFORM_ADMINS_JWKS_URL_OVERRIDE:
        'http://127.0.0.1:9001/platform/.well-known/jwks.json',
    });
    expect(parsed.COGNITO_PLATFORM_ADMINS_POOL_ID).toBe('eu-central-1_PLT999');
    expect(parsed.COGNITO_PLATFORM_ADMINS_CLIENT_ID).toBe('client-plt');
    expect(parsed.COGNITO_PLATFORM_ADMINS_JWKS_URL_OVERRIDE).toMatch(/127\.0\.0\.1/);
  });

  it('rejects a malformed COGNITO_PLATFORM_ADMINS_POOL_ID when set', () => {
    expect(() => parseEnv({ ...valid, COGNITO_PLATFORM_ADMINS_POOL_ID: 'wrong_pool_id' })).toThrow(
      /COGNITO_PLATFORM_ADMINS_POOL_ID/,
    );
  });

  it('rejects a non-URL COGNITO_PLATFORM_ADMINS_JWKS_URL_OVERRIDE when set', () => {
    expect(() =>
      parseEnv({ ...valid, COGNITO_PLATFORM_ADMINS_JWKS_URL_OVERRIDE: 'not-a-url' }),
    ).toThrow(/COGNITO_PLATFORM_ADMINS_JWKS_URL_OVERRIDE/);
  });
});
