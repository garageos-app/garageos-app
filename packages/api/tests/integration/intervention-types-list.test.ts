import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import {
  createTenantWithLocation,
  createUser,
  ensureSystemInterventionType,
  resetDb,
} from './helpers.js';
import { pgAdmin } from './setup.js';
import { signTestToken } from '../helpers/jwt.js';

// Per feedback_integration_test_rate_limit_isolation.md — unique IP per
// describe block keeps the @fastify/rate-limit bucket isolated when the
// app is shared via beforeAll across tests.
const TEST_IP = '10.20.30.41';

describe('GET /v1/intervention-types (integration)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestServer();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
    // resetDb() TRUNCATEs tenants CASCADE — Postgres truncates the entire
    // intervention_types table even though tenant_id NULL rows have no
    // matching tenant FK. Re-seed the system rows used in these tests.
    await ensureSystemInterventionType('MECCANICO');
    await ensureSystemInterventionType('GOMME');
    await ensureSystemInterventionType('REVISIONE');
  });

  // Hardcoded sub shared across all authedRequest calls. tenant-context
  // middleware now requires an active users row matching cognitoSub ×
  // tenantId, so each caller must seed a user with this sub before
  // invoking authedRequest (resetDb wipes users between tests so a
  // per-test seed in each it() block is required).
  const AUTHED_SUB = '11111111-1111-4111-8111-111111111111';

  async function authedRequest(tenantId: string) {
    // Seed the user so tenant-context middleware finds an active row.
    await createUser({
      tenantId,
      cognitoSub: AUTHED_SUB,
      email: 'test-mechanic@test.it',
      role: 'mechanic',
    });
    const token = await signTestToken({
      pool: 'officine',
      sub: AUTHED_SUB,
      tenantId,
      role: 'mechanic',
    });
    return app.inject({
      method: 'GET',
      url: '/v1/intervention-types',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });
  }

  it('returns system-wide types only for fresh tenant', async () => {
    const { tenantId } = await createTenantWithLocation('itypes-fresh');
    const res = await authedRequest(tenantId);
    expect(res.statusCode).toBe(200);
    const json = res.json() as {
      data: Array<{ code: string; custom: boolean; tenantId?: unknown }>;
    };
    expect(json.data.length).toBeGreaterThanOrEqual(3);
    expect(json.data.every((r) => r.custom === false)).toBe(true);
    expect(json.data.every((r) => !('tenantId' in r))).toBe(true);
  });

  it('includes tenant custom rows alongside system', async () => {
    const { tenantId } = await createTenantWithLocation('itypes-custom');
    await pgAdmin.query(
      `INSERT INTO intervention_types
        (id, tenant_id, code, name_it, description, icon, suggests_deadline,
         created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'CUSTOM_FOO', 'Custom Foo', 'Test', 'wrench',
        false, NOW(), NOW())`,
      [tenantId],
    );
    const res = await authedRequest(tenantId);
    expect(res.statusCode).toBe(200);
    const json = res.json() as { data: Array<{ code: string; custom: boolean }> };
    const custom = json.data.find((r) => r.code === 'CUSTOM_FOO');
    expect(custom).toBeDefined();
    expect(custom!.custom).toBe(true);
  });

  it('isolates tenant custom rows cross-tenant', async () => {
    const { tenantId: tenantA } = await createTenantWithLocation('itypes-a');
    const { tenantId: tenantB } = await createTenantWithLocation('itypes-b');
    await pgAdmin.query(
      `INSERT INTO intervention_types
        (id, tenant_id, code, name_it, description, icon, suggests_deadline,
         created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'TENANT_A_ONLY', 'A only', 'X', 'wrench',
        false, NOW(), NOW())`,
      [tenantA],
    );
    const res = await authedRequest(tenantB);
    const json = res.json() as { data: Array<{ code: string }> };
    expect(json.data.find((r) => r.code === 'TENANT_A_ONLY')).toBeUndefined();
  });

  it('orders by nameIt ASC', async () => {
    const { tenantId } = await createTenantWithLocation('itypes-order');
    // Seed two global types whose names are alphabetically out of insertion
    // order, so a passing assertion actually exercises server-side ordering
    // rather than incidentally reflecting insertion order.
    await pgAdmin.query(
      `INSERT INTO intervention_types
        (id, tenant_id, code, name_it, description, icon, suggests_deadline,
         created_at, updated_at)
       VALUES
        (gen_random_uuid(), NULL, 'ORDER_ZETA', 'Zeta Tipo Ordinamento', 'Test', 'wrench', false, NOW(), NOW()),
        (gen_random_uuid(), NULL, 'ORDER_ALFA', 'Alfa Tipo Ordinamento', 'Test', 'wrench', false, NOW(), NOW())`,
    );
    const res = await authedRequest(tenantId);
    const json = res.json() as { data: Array<{ nameIt: string }> };
    for (let i = 1; i < json.data.length; i++) {
      expect(json.data[i - 1]!.nameIt.localeCompare(json.data[i]!.nameIt)).toBeLessThanOrEqual(0);
    }
    const alfaIdx = json.data.findIndex((r) => r.nameIt === 'Alfa Tipo Ordinamento');
    const zetaIdx = json.data.findIndex((r) => r.nameIt === 'Zeta Tipo Ordinamento');
    expect(alfaIdx).toBeGreaterThanOrEqual(0);
    expect(zetaIdx).toBeGreaterThan(alfaIdx);
  });

  it('returns 401 without token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/intervention-types',
      headers: { 'x-forwarded-for': TEST_IP },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  });

  it('returns 403 for clienti pool token', async () => {
    const { tenantId } = await createTenantWithLocation('itypes-clienti');
    const token = await signTestToken({
      pool: 'clienti',
      sub: '22222222-2222-4222-8222-222222222222',
      tenantId,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/intervention-types',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });
    expect(res.statusCode).toBe(403);
  });
});
