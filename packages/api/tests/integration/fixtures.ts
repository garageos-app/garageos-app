import type { FastifyInstance } from 'fastify';

import { buildServer } from '../../src/server.js';

// Integration test entry point. PR 6 shipped a test-only route
// `/test/locations` here to exercise the header→tenantContext→RLS
// chain; PR 7 replaces that with real /v1/users/me + /v1/tenants/me
// endpoints, which cover the same chain plus the JWT auth layer end-
// to-end. See tests/integration/users-me.test.ts and tenants-me.test.ts.
//
// Integration tests that need a custom auth verifier (e.g. to feed
// test JWKs rather than hit the mock JWKS server) can pass `auth` via
// BuildServerOptions from src/server.ts.
export async function buildTestServer(): Promise<FastifyInstance> {
  return buildServer();
}
