import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import {
  createCustomer,
  createCustomerTenantRelation,
  createOwnership,
  createTenantWithLocation,
  createUser,
  createVehicle,
  resetDb,
} from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';

const TEST_IP = '10.20.31.41';

describe('GET /v1/customers/:id (integration)', () => {
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

  async function setupOfficinaCaller(suffix: string) {
    const { tenantId } = await createTenantWithLocation(suffix);
    const cognitoSub = `cd-caller-${suffix}`;
    await createUser({ tenantId, cognitoSub, role: 'super_admin' });
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
    });
    return { tenantId, token };
  }

  it('returns 200 with full DTO including tenantRelation block + vehicles', async () => {
    const { tenantId, token } = await setupOfficinaCaller('detail-200');
    const { customerId } = await createCustomer({
      firstName: 'Mario',
      lastName: 'Rossi',
      phone: '+39 333 1234567',
      taxCode: 'RSSMRA80A01H501Z',
      addressLine: 'Via Roma 1',
      city: 'Roma',
      province: 'RM',
      postalCode: '00100',
    });
    await createCustomerTenantRelation({
      tenantId,
      customerId,
      tenantNotes: 'Cliente VIP',
      interventionCount: 3,
      firstInterventionAt: new Date('2025-01-15T10:00:00Z'),
      lastInterventionAt: new Date('2026-04-30T09:00:00Z'),
    });
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    await createOwnership({ vehicleId, customerId });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/customers/${customerId}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      id: customerId,
      firstName: 'Mario',
      lastName: 'Rossi',
      phone: '+39 333 1234567',
      taxCode: 'RSSMRA80A01H501Z',
      addressLine: 'Via Roma 1',
      city: 'Roma',
      province: 'RM',
      postalCode: '00100',
      status: 'active',
      tenantRelation: {
        tenantNotes: 'Cliente VIP',
        interventionCount: 3,
        firstInterventionAt: '2025-01-15T10:00:00.000Z',
        lastInterventionAt: '2026-04-30T09:00:00.000Z',
      },
    });
    expect(body.vehicles).toHaveLength(1);
    expect(body.vehicles[0].id).toBe(vehicleId);
  });

  it('returns 200 with vehicles=[] when customer has no current ownership', async () => {
    const { tenantId, token } = await setupOfficinaCaller('detail-novehicles');
    const { customerId } = await createCustomer({});
    await createCustomerTenantRelation({ tenantId, customerId });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/customers/${customerId}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().vehicles).toEqual([]);
  });

  it('returns 404 when customer does not exist', async () => {
    const { token } = await setupOfficinaCaller('detail-noexist');
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const res = await app.inject({
      method: 'GET',
      url: `/v1/customers/${fakeId}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/customer.not_found',
      status: 404,
    });
  });

  it('returns 404 when customer exists but no CTR for caller tenant', async () => {
    const { token } = await setupOfficinaCaller('detail-noctr');
    const { tenantId: otherTenantId } = await createTenantWithLocation('detail-noctr-other');
    const { customerId } = await createCustomer({});
    await createCustomerTenantRelation({ tenantId: otherTenantId, customerId });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/customers/${customerId}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('customer.not_found');
  });

  it('returns 404 when CTR has customerDeleted=true (BR-158)', async () => {
    const { tenantId, token } = await setupOfficinaCaller('detail-deletedctr');
    const { customerId } = await createCustomer({});
    await createCustomerTenantRelation({
      tenantId,
      customerId,
      customerDeleted: true,
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/customers/${customerId}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('customer.not_found');
  });

  it('returns 404 when customer.status=deleted', async () => {
    const { tenantId, token } = await setupOfficinaCaller('detail-statusdel');
    const { customerId } = await createCustomer({ status: 'deleted' });
    await createCustomerTenantRelation({ tenantId, customerId });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/customers/${customerId}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 401 when no auth header', async () => {
    const { customerId } = await createCustomer({});
    const res = await app.inject({
      method: 'GET',
      url: `/v1/customers/${customerId}`,
      headers: { 'x-forwarded-for': TEST_IP },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 when authenticated via clienti pool', async () => {
    const cognitoSub = 'cust-sub-' + Math.random().toString(36).slice(2, 10);
    const { customerId } = await createCustomer({ cognitoSub });
    const token = await signTestToken({ pool: 'clienti', sub: cognitoSub, customerId });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/customers/${customerId}`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 400 VALIDATION_ERROR when :id is not a uuid', async () => {
    const { token } = await setupOfficinaCaller('detail-baduuid');
    const res = await app.inject({
      method: 'GET',
      url: `/v1/customers/not-a-uuid`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });
});
