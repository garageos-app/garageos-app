import type { FastifyInstance } from 'fastify';

import { buildServer } from '../../src/server.js';
import { getTestKey, initKeys } from '../helpers/jwt.js';

// Integration test entry point. PR 6 shipped a test-only route
// `/test/locations` here to exercise the header→tenantContext→RLS
// chain; PR 7 replaces that with real /v1/users/me + /v1/tenants/me
// endpoints, which cover the same chain plus the JWT auth layer end-
// to-end. See tests/integration/users-me.test.ts and tenants-me.test.ts.
//
// buildTestServer pre-seeds the auth plugin's JWKS cache with the test
// key pairs so it never needs to reach out over HTTPS. aws-jwt-verify
// 5.x accepts only https:// URLs through its built-in fetcher, which
// is why we do not run a local HTTP JWKS mock server.
export async function buildTestServer(): Promise<FastifyInstance> {
  // Idempotent; integration/setup.ts already awaits it but calling
  // again here guarantees keys exist even if this fixture is imported
  // in isolation.
  await initKeys();

  return buildServer({
    auth: {
      officineJwks: [getTestKey('officine').publicJwk],
      clientiJwks: [getTestKey('clienti').publicJwk],
      // Slice 0: pre-seed the platform-admins verifier cache so the test
      // app validates platform-admins tokens without hitting AWS.
      // COGNITO_PLATFORM_ADMINS_POOL_ID / _CLIENT_ID must already be set in
      // the env (globalSetup.ts) for buildVerifier to construct the verifier;
      // this option then seeds its JWKS cache.
      platformAdminsJwks: [getTestKey('platform-admins').publicJwk],
    },
  });
}
