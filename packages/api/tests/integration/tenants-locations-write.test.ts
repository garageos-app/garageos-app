import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import { createTenantWithLocation, createUser, resetDb } from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';
import { pgAdmin } from './setup.js';

// Unique remoteAddress per describe block to isolate any global rate-limit
// bucket (feedback_integration_test_rate_limit_isolation).
const IP_POST = '10.20.41.1';
const IP_PATCH = '10.20.42.1';
const IP_DELETE = '10.20.43.1';

async function superAdminToken(tenantId: string, locationId: string) {
  const sub = `sa-locw-${crypto.randomUUID()}`;
  await createUser({
    tenantId,
    cognitoSub: sub,
    email: `${sub}@locw.test`,
    role: 'super_admin',
    locationId,
  });
  return signTestToken({ pool: 'officine', sub, tenantId, role: 'super_admin' });
}

async function insertSecondaryLocation(tenantId: string, name = 'Sede 2') {
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO locations (id, tenant_id, name, address_line, city, province,
       postal_code, country, is_primary, status, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'Via 2', 'Roma', 'RM', '00100', 'IT',
       false, 'active'::"LocationStatus", NOW(), NOW()) RETURNING id`,
    [tenantId, name],
  );
  return rows[0]!.id;
}

describe('POST /v1/tenants/me/locations', () => {
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

  it('creates a secondary location (isPrimary=false, active)', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('locw-create');
    const token = await superAdminToken(tenantId, locationId);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/tenants/me/locations',
      remoteAddress: IP_POST,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: 'Sede Roma',
        addressLine: 'Via Roma 1',
        city: 'Roma',
        province: 'rm',
        postalCode: '00100',
        phone: '+39 06 1234567',
      },
    });

    expect(res.statusCode).toBe(201);
    const { location } = res.json() as { location: Record<string, unknown> };
    expect(location.isPrimary).toBe(false);
    expect(location.status).toBe('active');
    expect(location.province).toBe('RM'); // uppercased
    expect(location.country).toBe('IT'); // default
    expect(location.email).toBeNull();
  });

  it('rejects isPrimary in POST body as unknown_field (422)', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('locw-create-prim');
    const token = await superAdminToken(tenantId, locationId);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/tenants/me/locations',
      remoteAddress: IP_POST,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: 'X',
        addressLine: 'Via 1',
        city: 'Roma',
        province: 'RM',
        postalCode: '00100',
        isPrimary: true,
      },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('tenants.me.locations.update.unknown_field');
  });

  it('returns 403 for mechanic', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('locw-create-403');
    const sub = `mech-locw-${crypto.randomUUID()}`;
    await createUser({
      tenantId,
      cognitoSub: sub,
      email: `${sub}@locw.test`,
      role: 'mechanic',
      locationId,
    });
    const token = await signTestToken({ pool: 'officine', sub, tenantId, role: 'mechanic' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/tenants/me/locations',
      remoteAddress: IP_POST,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: 'X',
        addressLine: 'Via 1',
        city: 'Roma',
        province: 'RM',
        postalCode: '00100',
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('auth.forbidden.super_admin_required');
  });

  it('returns 400 VALIDATION_ERROR on malformed province', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('locw-create-val');
    const token = await superAdminToken(tenantId, locationId);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/tenants/me/locations',
      remoteAddress: IP_POST,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: 'X',
        addressLine: 'Via 1',
        city: 'Roma',
        province: 'ROMA',
        postalCode: '00100',
      },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('PATCH /v1/tenants/me/locations/:id', () => {
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

  it('edits address fields', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('locw-patch');
    const token = await superAdminToken(tenantId, locationId);

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/tenants/me/locations/${locationId}`,
      remoteAddress: IP_PATCH,
      headers: { authorization: `Bearer ${token}` },
      payload: { city: 'Torino', province: 'to' },
    });

    expect(res.statusCode).toBe(200);
    const { location } = res.json() as { location: Record<string, unknown> };
    expect(location.city).toBe('Torino');
    expect(location.province).toBe('TO');
  });

  it('promotes a secondary to primary, demoting the old primary (exactly one primary)', async () => {
    const { tenantId, locationId: primaryId } = await createTenantWithLocation('locw-swap');
    const token = await superAdminToken(tenantId, primaryId);
    const secId = await insertSecondaryLocation(tenantId);

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/tenants/me/locations/${secId}`,
      remoteAddress: IP_PATCH,
      headers: { authorization: `Bearer ${token}` },
      payload: { isPrimary: true },
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { location: { isPrimary: boolean } }).location.isPrimary).toBe(true);

    const { rows } = await pgAdmin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM locations
       WHERE tenant_id = $1 AND is_primary = true AND status = 'active' AND deleted_at IS NULL`,
      [tenantId],
    );
    expect(rows[0]!.count).toBe('1');
    const { rows: oldPrimary } = await pgAdmin.query<{ is_primary: boolean }>(
      `SELECT is_primary FROM locations WHERE id = $1`,
      [primaryId],
    );
    expect(oldPrimary[0]!.is_primary).toBe(false);
  });

  it('rejects explicit isPrimary:false (422 cannot_unset_primary)', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('locw-unset');
    const token = await superAdminToken(tenantId, locationId);

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/tenants/me/locations/${locationId}`,
      remoteAddress: IP_PATCH,
      headers: { authorization: `Bearer ${token}` },
      payload: { isPrimary: false },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('tenants.me.locations.cannot_unset_primary');
  });

  it('rejects empty body (422 empty_body)', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('locw-empty');
    const token = await superAdminToken(tenantId, locationId);

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/tenants/me/locations/${locationId}`,
      remoteAddress: IP_PATCH,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('tenants.me.locations.update.empty_body');
  });

  it('rejects unknown field (422 unknown_field)', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('locw-unk');
    const token = await superAdminToken(tenantId, locationId);

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/tenants/me/locations/${locationId}`,
      remoteAddress: IP_PATCH,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: 'inactive' },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('tenants.me.locations.update.unknown_field');
  });

  it('returns 404 for a location of another tenant', async () => {
    const { locationId: lA } = await createTenantWithLocation('locw-iso-A');
    const { tenantId: tB, locationId: lB } = await createTenantWithLocation('locw-iso-B');
    const tokenB = await superAdminToken(tB, lB);

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/tenants/me/locations/${lA}`,
      remoteAddress: IP_PATCH,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { city: 'Hack' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('tenants.me.locations.not_found');
  });
});

describe('DELETE /v1/tenants/me/locations/:id', () => {
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

  it('soft-deletes a secondary location without users', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('locw-del-ok');
    const token = await superAdminToken(tenantId, locationId);
    const secId = await insertSecondaryLocation(tenantId);

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/tenants/me/locations/${secId}`,
      remoteAddress: IP_DELETE,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { location: { status: string } }).location.status).toBe('inactive');
    const { rows } = await pgAdmin.query<{ deleted_at: string | null }>(
      `SELECT deleted_at FROM locations WHERE id = $1`,
      [secId],
    );
    expect(rows[0]!.deleted_at).not.toBeNull();
  });

  it('rejects deleting the primary (422 cannot_delete_primary)', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('locw-del-prim');
    const token = await superAdminToken(tenantId, locationId);

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/tenants/me/locations/${locationId}`,
      remoteAddress: IP_DELETE,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('tenants.me.locations.cannot_delete_primary');
  });

  it('rejects deleting a location with active mechanics (422 has_active_users)', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('locw-del-users');
    const token = await superAdminToken(tenantId, locationId);
    const secId = await insertSecondaryLocation(tenantId);
    await createUser({
      tenantId,
      cognitoSub: `mech-del-${crypto.randomUUID()}`,
      email: `mech-del-${crypto.randomUUID()}@locw.test`,
      role: 'mechanic',
      locationId: secId,
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/tenants/me/locations/${secId}`,
      remoteAddress: IP_DELETE,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('tenants.me.locations.has_active_users');
  });

  it('returns 404 for a non-existent / cross-tenant location id', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('locw-del-404');
    const token = await superAdminToken(tenantId, locationId);

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/tenants/me/locations/${crypto.randomUUID()}`,
      remoteAddress: IP_DELETE,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('tenants.me.locations.not_found');
  });

  it('returns 404 when re-deleting an already-deactivated location', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('locw-del-twice');
    const token = await superAdminToken(tenantId, locationId);
    const secId = await insertSecondaryLocation(tenantId);

    const first = await app.inject({
      method: 'DELETE',
      url: `/v1/tenants/me/locations/${secId}`,
      remoteAddress: IP_DELETE,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'DELETE',
      url: `/v1/tenants/me/locations/${secId}`,
      remoteAddress: IP_DELETE,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(second.statusCode).toBe(404);
    expect(second.json().code).toBe('tenants.me.locations.not_found');
  });
});
