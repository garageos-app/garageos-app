import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import {
  createCustomer,
  createDispute,
  createIntervention,
  createTenantWithLocation,
  createUser,
  createVehicle,
  ensureSystemInterventionType,
  resetDb,
} from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';

const TEST_IP = '10.20.32.51';

describe('GET /v1/interventions/:id/disputes (integration)', () => {
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
    const cognitoSub = `dl-caller-${suffix}`;
    const { userId } = await createUser({
      tenantId,
      cognitoSub,
      role: 'super_admin',
    });
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
    });
    return { tenantId, userId, token };
  }

  async function setupInterventionForTenant(args: { tenantId: string; userId: string }) {
    const { customerId } = await createCustomer({});
    const { vehicleId } = await createVehicle({ createdByTenantId: args.tenantId });
    const interventionType = await ensureSystemInterventionType('TAGLIANDO');
    const { interventionId } = await createIntervention({
      tenantId: args.tenantId,
      userId: args.userId,
      vehicleId,
      interventionTypeId: interventionType.id,
      interventionDate: '2026-04-01',
      odometerKm: 30000,
    });
    return { customerId, interventionId };
  }

  it('returns 200 with empty disputes array when intervention has no dispute', async () => {
    const { tenantId, userId, token } = await setupOfficinaCaller('list-empty');
    const { interventionId } = await setupInterventionForTenant({ tenantId, userId });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${interventionId}/disputes`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ disputes: [] });
  });

  it('returns 200 with 2 open disputes ordered by createdAt asc', async () => {
    const { tenantId, userId, token } = await setupOfficinaCaller('list-2open');
    const { customerId, interventionId } = await setupInterventionForTenant({
      tenantId,
      userId,
    });
    const { disputeId: d1 } = await createDispute({
      interventionId,
      customerId,
      reasonCategory: 'not_performed',
      customerDescription: 'Lavoro non eseguito come da preventivo concordato.',
    });
    // Force ordering: second dispute is inserted ~50ms later
    await new Promise((r) => setTimeout(r, 50));
    const { disputeId: d2 } = await createDispute({
      interventionId,
      customerId,
      reasonCategory: 'wrong_data',
      customerDescription: 'Targa veicolo registrata errata sul documento.',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${interventionId}/disputes`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.disputes).toHaveLength(2);
    expect(body.disputes[0].id).toBe(d1);
    expect(body.disputes[1].id).toBe(d2);
    expect(body.disputes[0]).toMatchObject({
      reasonCategory: 'not_performed',
      customerDescription: 'Lavoro non eseguito come da preventivo concordato.',
      status: 'open',
      tenantResponse: null,
      tenantResponseAt: null,
      tenantResponseUser: null,
      resolvedAt: null,
    });
  });

  it('returns 200 with 1 open + 1 responded dispute (responded includes tenantResponseUser)', async () => {
    const { tenantId, userId, token } = await setupOfficinaCaller('list-mixed');
    const { customerId, interventionId } = await setupInterventionForTenant({
      tenantId,
      userId,
    });
    await createDispute({ interventionId, customerId, status: 'open' });
    await createDispute({
      interventionId,
      customerId,
      status: 'responded',
      reasonCategory: 'other',
      tenantResponse: 'Abbiamo verificato e tutto risulta in regola. Allegata documentazione.',
      tenantResponseAt: new Date('2026-04-15T10:30:00Z'),
      tenantResponseUserId: userId,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${interventionId}/disputes`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.disputes).toHaveLength(2);
    const responded = body.disputes.find((d: { status: string }) => d.status === 'responded');
    expect(responded).toMatchObject({
      tenantResponse: 'Abbiamo verificato e tutto risulta in regola. Allegata documentazione.',
      tenantResponseAt: '2026-04-15T10:30:00.000Z',
      tenantResponseUser: { firstName: 'Test', lastName: 'User' },
    });
    const openDispute = body.disputes.find((d: { status: string }) => d.status === 'open');
    expect(openDispute?.tenantResponseUser).toBeNull();
    expect(openDispute?.tenantResponse).toBeNull();
  });

  it('returns 200 with all 5 status flavours', async () => {
    const { tenantId, userId, token } = await setupOfficinaCaller('list-5states');
    const { customerId, interventionId } = await setupInterventionForTenant({
      tenantId,
      userId,
    });
    await createDispute({ interventionId, customerId, status: 'open' });
    await createDispute({
      interventionId,
      customerId,
      status: 'responded',
      tenantResponse: 'Risposta tecnica dettagliata sul punto contestato.',
      tenantResponseAt: new Date(),
      tenantResponseUserId: userId,
    });
    await createDispute({
      interventionId,
      customerId,
      status: 'resolved_by_cancellation',
      resolvedAt: new Date(),
    });
    await createDispute({ interventionId, customerId, status: 'escalated' });
    await createDispute({ interventionId, customerId, status: 'closed_by_admin' });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${interventionId}/disputes`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.disputes).toHaveLength(5);
    const statuses = body.disputes.map((d: { status: string }) => d.status).sort();
    expect(statuses).toEqual([
      'closed_by_admin',
      'escalated',
      'open',
      'resolved_by_cancellation',
      'responded',
    ]);
  });

  it('returns 404 when intervention belongs to a different tenant (RLS-as-404)', async () => {
    const { tenantId: tenantA, userId: userA } = await setupOfficinaCaller('list-x-A');
    const { customerId, interventionId } = await setupInterventionForTenant({
      tenantId: tenantA,
      userId: userA,
    });
    await createDispute({ interventionId, customerId });

    // Caller is tenant B
    const { token: tokenB } = await setupOfficinaCaller('list-x-B');
    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${interventionId}/disputes`,
      headers: { authorization: `Bearer ${tokenB}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('intervention.not_found');
  });

  it('returns 404 when intervention id does not exist', async () => {
    const { token } = await setupOfficinaCaller('list-noexist');
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${fakeId}/disputes`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('intervention.not_found');
  });

  it('returns 401 when no Authorization header is provided', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${fakeId}/disputes`,
      headers: { 'x-forwarded-for': TEST_IP },
    });
    expect(res.statusCode).toBe(401);
  });
});
