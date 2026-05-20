import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import { createTenantWithLocation, createUser, resetDb } from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';
import { pgAdmin } from './setup.js';

describe('GET /v1/tenants/me/locations', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestServer();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
  });

  it('returns 200 with active locations ordered isPrimary desc + name asc for super_admin', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('loc-list-ok');

    // Add a second non-primary location whose name sorts before 'Sede'
    await pgAdmin.query(
      `INSERT INTO locations
         (id, tenant_id, name, address_line, city, province, postal_code,
          country, is_primary, status, created_at, updated_at)
       VALUES
         (gen_random_uuid(), $1, 'Agenzia', 'Via Agenzia 2', 'Roma', 'RM',
          '00100', 'IT', false, 'active'::"LocationStatus", NOW(), NOW())`,
      [tenantId],
    );

    const adminSub = `sa-loc-${crypto.randomUUID()}`;
    await createUser({
      tenantId,
      cognitoSub: adminSub,
      email: 'sa@loc-list.test',
      role: 'super_admin',
      locationId,
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: adminSub,
      tenantId,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/tenants/me/locations',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      locations: { id: string; name: string; city: string; isPrimary: boolean }[];
    };
    expect(body.locations).toHaveLength(2);
    // Primary location comes first (isPrimary desc)
    expect(body.locations[0]!.isPrimary).toBe(true);
    expect(body.locations[0]!.name).toBe('Sede');
    expect(body.locations[1]!.isPrimary).toBe(false);
    expect(body.locations[1]!.name).toBe('Agenzia');
    // Shape check: id, name, city, isPrimary present
    expect(body.locations[0]).toHaveProperty('id');
    expect(body.locations[0]).toHaveProperty('name');
    expect(body.locations[0]).toHaveProperty('city');
    expect(body.locations[0]).toHaveProperty('isPrimary');
  });

  it('returns 403 for mechanic', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('loc-list-403');
    const mechSub = `mech-loc-403-${crypto.randomUUID()}`;
    await createUser({
      tenantId,
      cognitoSub: mechSub,
      email: 'mech@loc-403.test',
      role: 'mechanic',
      locationId,
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: mechSub,
      tenantId,
      role: 'mechanic',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/tenants/me/locations',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('auth.forbidden.super_admin_required');
  });

  it('does not leak cross-tenant locations to super_admin of another tenant', async () => {
    const { tenantId: t1, locationId: l1 } = await createTenantWithLocation('loc-list-iso-A');
    const { tenantId: t2, locationId: l2 } = await createTenantWithLocation('loc-list-iso-B');

    const sa1Sub = `sa1-loc-${crypto.randomUUID()}`;
    await createUser({
      tenantId: t1,
      cognitoSub: sa1Sub,
      email: 'sa1@loc-iso.test',
      role: 'super_admin',
      locationId: l1,
    });
    // Seed a user in t2 to ensure t2 has data that must not leak
    const sa2Sub = `sa2-loc-${crypto.randomUUID()}`;
    await createUser({
      tenantId: t2,
      cognitoSub: sa2Sub,
      email: 'sa2@loc-iso.test',
      role: 'super_admin',
      locationId: l2,
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: sa1Sub,
      tenantId: t1,
      role: 'super_admin',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/tenants/me/locations',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { locations: { id: string }[] };
    // Only tenant A's location must be returned (application-layer tenant
    // filter — SELECT RLS on locations is permissive, USING true).
    expect(body.locations).toHaveLength(1);
    expect(body.locations[0]!.id).toBe(l1);
  });
});
