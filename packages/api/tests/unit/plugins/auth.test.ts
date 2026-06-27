import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import authPlugin from '../../../src/plugins/auth.js';
import { buildIssuer, getTestKey, signTestToken } from '../../helpers/jwt.js';

// Unit tests use the plugin's in-memory verifier path: public JWKs are
// passed directly via options, no HTTP fetch involved. Integration tests
// exercise the real aws-jwt-verify HTTP path against the mock JWKS
// server (tests/helpers/jwks-server.ts) in Task 13.

async function registerWithTestKeys(app: FastifyInstance): Promise<void> {
  await app.register(authPlugin, {
    officineJwks: [getTestKey('officine').publicJwk],
    clientiJwks: [getTestKey('clienti').publicJwk],
    platformAdminsJwks: [getTestKey('platform-admins').publicJwk],
  });
}

describe('authPlugin (in-memory verifier path)', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = Fastify({ logger: false });
  });

  afterEach(async () => {
    await app.close();
  });

  it('decorates app.jwtVerifier with a verify function', async () => {
    await registerWithTestKeys(app);
    expect(app.jwtVerifier).toBeDefined();
    expect(typeof app.jwtVerifier.verify).toBe('function');
  });

  it('verifies an officine ID token and returns pool + payload', async () => {
    await registerWithTestKeys(app);
    const token = await signTestToken({
      pool: 'officine',
      tenantId: '11111111-1111-4111-8111-111111111111',
      role: 'mechanic',
    });

    const result = await app.jwtVerifier.verify(token);

    expect(result.pool).toBe('officine');
    expect(result.payload.sub).toBeDefined();
    expect(result.payload['custom:tenant_id']).toBe('11111111-1111-4111-8111-111111111111');
    expect(result.payload['custom:role']).toBe('mechanic');
    expect(result.payload.token_use).toBe('id');
  });

  it('verifies a clienti ID token and returns pool=clienti', async () => {
    await registerWithTestKeys(app);
    const token = await signTestToken({ pool: 'clienti' });

    const result = await app.jwtVerifier.verify(token);

    expect(result.pool).toBe('clienti');
    expect(result.payload['custom:customer_id']).toBeDefined();
  });

  it('rejects a malformed JWT', async () => {
    await registerWithTestKeys(app);
    await expect(app.jwtVerifier.verify('not.a.valid.jwt')).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    await registerWithTestKeys(app);
    const token = await signTestToken({ pool: 'officine', expSecondsFromNow: -60 });
    await expect(app.jwtVerifier.verify(token)).rejects.toThrow();
  });

  it('rejects a token with wrong audience', async () => {
    await registerWithTestKeys(app);
    const token = await signTestToken({ pool: 'officine', audience: 'some-other-client-id' });
    await expect(app.jwtVerifier.verify(token)).rejects.toThrow();
  });

  it('rejects an access token (token_use != id)', async () => {
    await registerWithTestKeys(app);
    const token = await signTestToken({ pool: 'officine', tokenUse: 'access' });
    await expect(app.jwtVerifier.verify(token)).rejects.toThrow();
  });

  it('rejects a token from an unknown issuer', async () => {
    await registerWithTestKeys(app);
    const token = await signTestToken({
      pool: 'officine',
      poolId: 'eu-central-1_STRANGEPOOL',
    });
    await expect(app.jwtVerifier.verify(token)).rejects.toThrow();
  });

  it('rejects a token signed by the wrong pool key (cross-pool replay)', async () => {
    await registerWithTestKeys(app);
    // sign with the clienti private key but claim to be from officine issuer
    const token = await signTestToken({
      pool: 'officine',
      signingKey: getTestKey('clienti'),
    });
    await expect(app.jwtVerifier.verify(token)).rejects.toThrow();
  });

  it('issuer helper produces the cognito-idp URL shape', () => {
    expect(buildIssuer('eu-central-1_ABC', 'eu-central-1')).toBe(
      'https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_ABC',
    );
  });

  // --- platform-admins pool (Slice 0) ---
  // The verifier is built conditionally: only when both
  // COGNITO_PLATFORM_ADMINS_POOL_ID and _CLIENT_ID are set in env.
  // setup.ts supplies those placeholders so the in-memory verifier path
  // is exercised here without any real Cognito call.

  it('verifies a platform-admins ID token and returns pool=platform-admins', async () => {
    await registerWithTestKeys(app);
    const token = await signTestToken({ pool: 'platform-admins' });

    const result = await app.jwtVerifier.verify(token);

    expect(result.pool).toBe('platform-admins');
    expect(result.payload.sub).toBeDefined();
    expect(result.payload.token_use).toBe('id');
  });

  it('still routes an officine token to pool=officine when platform-admins is also configured', async () => {
    await registerWithTestKeys(app);
    const token = await signTestToken({
      pool: 'officine',
      tenantId: '22222222-2222-4222-8222-222222222222',
      role: 'mechanic',
    });

    const result = await app.jwtVerifier.verify(token);

    expect(result.pool).toBe('officine');
    expect(result.payload['custom:tenant_id']).toBe('22222222-2222-4222-8222-222222222222');
  });

  it('rejects a platform-admins token signed by the wrong pool key (cross-pool replay)', async () => {
    await registerWithTestKeys(app);
    // Sign with the officine private key but claim to be from the platform-admins issuer.
    const token = await signTestToken({
      pool: 'platform-admins',
      signingKey: getTestKey('officine'),
    });
    await expect(app.jwtVerifier.verify(token)).rejects.toThrow();
  });

  // Finding 3 (Minor): customJwtCheck enforces id-token on the platform-admins
  // verifier the same way it does on officine / clienti. Verify an access token
  // for the platform-admins pool is rejected when the pool IS configured.
  it('rejects a platform-admins access token (token_use must be id)', async () => {
    await registerWithTestKeys(app);
    const token = await signTestToken({ pool: 'platform-admins', tokenUse: 'access' });
    await expect(app.jwtVerifier.verify(token)).rejects.toThrow();
  });
});
