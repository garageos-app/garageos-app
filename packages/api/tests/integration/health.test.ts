import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';

// Exercises /health against a real Testcontainers Postgres. The
// degraded (503) path is covered by the unit test with a throwing
// fake — container-kill mid-run is flaky and adds no coverage here.

describe('GET /health (integration)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestServer();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 with services.database=ok against a live DB', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'ok',
      services: { database: 'ok' },
    });
  });
});
