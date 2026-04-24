import type { FastifyInstance } from 'fastify';

import { buildServer } from '../../src/server.js';
import { tenantContext } from '../../src/middleware/tenant-context.js';

// Build a Fastify app against the real Testcontainers Postgres, wired
// with the default @garageos/database singleton (no overrides). A
// test-only route `/test/locations` reads back the caller's tenant
// locations through `withContext` — that verifies the full chain:
//   header → tenantContext → request.tenantId → withContext(...) → RLS.
// The route lives here, not in src/, so PR 6 ships no prod-routable
// endpoints other than the existing /health.

export async function buildTestServer(): Promise<FastifyInstance> {
  const app = await buildServer();

  app.get('/test/locations', { preHandler: tenantContext }, async (request) => {
    const rows = await app.withContext({ tenantId: request.tenantId! }, (tx) =>
      tx.location.findMany({ select: { id: true, tenantId: true, name: true } }),
    );
    return { locations: rows };
  });

  return app;
}
