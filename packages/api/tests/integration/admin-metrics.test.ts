// Integration tests for GET /v1/admin/metrics — Slice 4 platform metrics.
//
// Tier-1:
//   1. Pool isolation — officine 403, clienti 403, no-auth 401.
//   2. Cross-tenant aggregate counts over a 2-tenant seed.
//   3. Trend: exactly 8 ascending weekly points, zero-filled, with a
//      backdated intervention landing in an earlier bucket.
//   4. Empty platform → all zeros, trend still 8 points all count 0.
//
// CI-only (Docker / Testcontainers). Do NOT run locally on Windows.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { PROBLEM_JSON_CONTENT_TYPE } from '../../src/config/constants.js';
import type { PlatformMetrics } from '../../src/lib/dtos/platform-metrics.js';

import { buildTestServer } from './fixtures.js';
import {
  resetDb,
  createTenant,
  createUser,
  createCustomer,
  createVehicle,
  createCustomerTenantRelation,
  createIntervention,
  ensureSystemInterventionType,
} from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';
import { pgAdmin } from './setup.js';

describe('GET /v1/admin/metrics — pool isolation (integration)', () => {
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

  it('returns 401 when no Authorization header is present', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/admin/metrics' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/UNAUTHORIZED',
      status: 401,
    });
  });

  it('returns 403 FORBIDDEN for an officine token', async () => {
    const token = await signTestToken({ pool: 'officine' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/metrics',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/FORBIDDEN',
      status: 403,
    });
  });

  it('returns 403 FORBIDDEN for a clienti token', async () => {
    const token = await signTestToken({ pool: 'clienti' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/metrics',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/FORBIDDEN',
      status: 403,
    });
  });
});

describe('GET /v1/admin/metrics — aggregate counts (integration)', () => {
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

  it('returns 200 with all-zero metrics and an 8-point zero trend on an empty platform', async () => {
    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/metrics',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as PlatformMetrics;
    expect(body.tenants).toEqual({ total: 0, active: 0, suspended: 0 });
    expect(body.usersTotal).toBe(0);
    expect(body.interventions).toEqual({ total: 0, last30d: 0 });
    expect(body.vehiclesTotal).toBe(0);
    expect(body.customersTotal).toBe(0);
    expect(body.trend).toHaveLength(8);
    expect(body.trend.every((p) => p.count === 0)).toBe(true);
    // Ascending by week (YYYY-MM-DD string sort == chronological).
    const weeks = body.trend.map((p) => p.week);
    expect([...weeks].sort()).toEqual(weeks);
  });

  it('aggregates counts across multiple tenants and buckets the trend', async () => {
    // Tenant A: active, 1 user, 2 vehicles, 2 customers, 3 interventions
    //   (2 recent + 1 backdated 3 weeks ago).
    // Tenant B: suspended, 1 user, 1 vehicle, 1 customer, 1 recent intervention.
    const itype = await ensureSystemInterventionType('tagliando');

    const { tenantId: tenantA } = await createTenant('metrics-A');
    const { tenantId: tenantB } = await createTenant('metrics-B');
    // Make B suspended.
    await pgAdmin.query(`UPDATE tenants SET status = 'suspended'::"TenantStatus" WHERE id = $1`, [
      tenantB,
    ]);

    const { userId: userA } = await createUser({
      tenantId: tenantA,
      cognitoSub: 'sub-metrics-a',
      role: 'super_admin',
    });
    const { userId: userB } = await createUser({
      tenantId: tenantB,
      cognitoSub: 'sub-metrics-b',
      role: 'super_admin',
    });

    const { vehicleId: vA1 } = await createVehicle({ createdByTenantId: tenantA });
    await createVehicle({ createdByTenantId: tenantA });
    const { vehicleId: vB1 } = await createVehicle({ createdByTenantId: tenantB });

    const { customerId: cA1 } = await createCustomer({ email: 'a1@test.it' });
    const { customerId: cA2 } = await createCustomer({ email: 'a2@test.it' });
    const { customerId: cB1 } = await createCustomer({ email: 'b1@test.it' });
    await createCustomerTenantRelation({ tenantId: tenantA, customerId: cA1 });
    await createCustomerTenantRelation({ tenantId: tenantA, customerId: cA2 });
    await createCustomerTenantRelation({ tenantId: tenantB, customerId: cB1 });

    const today = new Date().toISOString().slice(0, 10);
    // 2 recent interventions on tenant A.
    await createIntervention({
      tenantId: tenantA,
      userId: userA,
      vehicleId: vA1,
      interventionTypeId: itype.id,
      interventionDate: today,
      odometerKm: 10000,
    });
    await createIntervention({
      tenantId: tenantA,
      userId: userA,
      vehicleId: vA1,
      interventionTypeId: itype.id,
      interventionDate: today,
      odometerKm: 10100,
    });
    // 1 backdated intervention (3 weeks ago) on tenant A → earlier trend bucket,
    // and OUTSIDE the last-30d window? No — 3 weeks < 30 days, so still last30d.
    const threeWeeksAgo = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000);
    await createIntervention({
      tenantId: tenantA,
      userId: userA,
      vehicleId: vA1,
      interventionTypeId: itype.id,
      interventionDate: today,
      odometerKm: 9000,
      createdAt: threeWeeksAgo,
    });
    // 1 recent intervention on tenant B.
    await createIntervention({
      tenantId: tenantB,
      userId: userB,
      vehicleId: vB1,
      interventionTypeId: itype.id,
      interventionDate: today,
      odometerKm: 5000,
    });

    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/metrics',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as PlatformMetrics;

    expect(body.tenants).toEqual({ total: 2, active: 1, suspended: 1 });
    expect(body.usersTotal).toBe(2);
    expect(body.interventions.total).toBe(4);
    expect(body.interventions.last30d).toBe(4); // all 4 within 30 days
    expect(body.vehiclesTotal).toBe(3);
    expect(body.customersTotal).toBe(3);

    // Trend: 8 buckets, sum of counts == 4, current week has the 3 recent ones,
    // the bucket 3 weeks back has the 1 backdated one.
    expect(body.trend).toHaveLength(8);
    const total = body.trend.reduce((acc, p) => acc + p.count, 0);
    expect(total).toBe(4);
    expect(body.trend[body.trend.length - 1]!.count).toBe(3); // current week
    // Exactly one earlier bucket carries the backdated intervention.
    const earlierWithOne = body.trend.slice(0, body.trend.length - 1).filter((p) => p.count === 1);
    expect(earlierWithOne).toHaveLength(1);
  });
});
