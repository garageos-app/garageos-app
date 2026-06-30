import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the S3 helper so no real AWS/PDF rendering happens; the integration
// value is the DB path (ownership gate, status filter, cross-tenant read).
vi.mock('../../src/lib/vehicle-history-pdf-s3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/vehicle-history-pdf-s3.js')>();
  return { ...actual, generateVehicleHistoryPdfPresignedUrl: vi.fn() };
});

import { generateVehicleHistoryPdfPresignedUrl } from '../../src/lib/vehicle-history-pdf-s3.js';
import { buildTestServer } from './fixtures.js';
import {
  createCustomer,
  createIntervention,
  createOwnership,
  createTenantWithLocation,
  createUser,
  createVehicle,
  ensureSystemInterventionType,
  resetDb,
} from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';

const MOCK_EXPIRES_AT = new Date(Date.now() + 3600 * 1000);

describe('GET /v1/me/vehicles/:id/export.pdf (integration)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.AWS_ACCESS_KEY_ID ??= 'test';
    process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
    process.env.S3_ATTACHMENTS_BUCKET ??= 'garageos-test-attachments';
    app = await buildTestServer();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
    await ensureSystemInterventionType('TAGLIANDO');
    vi.clearAllMocks();
    vi.mocked(generateVehicleHistoryPdfPresignedUrl).mockImplementation(async ({ vehicleId }) => ({
      url: `https://garageos-test-attachments.s3.eu-west-1.amazonaws.com/vehicle-history-pdfs/${vehicleId}.pdf?X-Amz-Signature=test`,
      expiresAt: MOCK_EXPIRES_AT,
    }));
  });

  async function seedShopIntervention(args: {
    tenantId: string;
    userId: string;
    vehicleId: string;
    status?: 'active' | 'disputed' | 'cancelled';
    date?: string;
  }) {
    const type = await ensureSystemInterventionType('TAGLIANDO');
    return createIntervention({
      tenantId: args.tenantId,
      userId: args.userId,
      vehicleId: args.vehicleId,
      interventionTypeId: type.id,
      interventionDate: args.date ?? '2026-05-20',
      odometerKm: 55000,
      title: 'Tagliando PDF',
      description: 'Cambio olio e filtri',
      partsReplaced: [],
      status: args.status ?? 'active',
    });
  }

  it('200 — owner: returns pdf_download_url, S3 called once with the vehicleId', async () => {
    const { tenantId } = await createTenantWithLocation('me-pdf-owner');
    const { userId } = await createUser({ tenantId, cognitoSub: 'mech-me-pdf-owner' });
    const { customerId } = await createCustomer({ cognitoSub: 'cust-me-pdf-owner' });
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    await createOwnership({ vehicleId, customerId });
    await seedShopIntervention({ tenantId, userId, vehicleId });

    const token = await signTestToken({ pool: 'clienti', sub: 'cust-me-pdf-owner', customerId });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${vehicleId}/export.pdf`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ pdf_download_url: string; expires_at: string }>();
    expect(body.pdf_download_url).toContain(`vehicle-history-pdfs/${vehicleId}.pdf`);
    expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now());
    expect(generateVehicleHistoryPdfPresignedUrl).toHaveBeenCalledOnce();
    expect(vi.mocked(generateVehicleHistoryPdfPresignedUrl).mock.calls[0]![0]).toMatchObject({
      vehicleId,
    });
  });

  it('404 — non-owner customer: me.vehicle.not_found, S3 not called', async () => {
    const { tenantId } = await createTenantWithLocation('me-pdf-iso');
    const { userId } = await createUser({ tenantId, cognitoSub: 'mech-me-pdf-iso' });
    const { customerId } = await createCustomer({ cognitoSub: 'cust-me-pdf-iso' });
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    await createOwnership({ vehicleId, customerId });
    await seedShopIntervention({ tenantId, userId, vehicleId });

    const { customerId: otherId } = await createCustomer({ cognitoSub: 'cust-me-pdf-other' });
    const token = await signTestToken({
      pool: 'clienti',
      sub: 'cust-me-pdf-other',
      customerId: otherId,
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${vehicleId}/export.pdf`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('me.vehicle.not_found');
    expect(generateVehicleHistoryPdfPresignedUrl).not.toHaveBeenCalled();
  });

  it('404 — ex-owner (endedAt set): me.vehicle.not_found', async () => {
    const { tenantId } = await createTenantWithLocation('me-pdf-ex');
    const { userId } = await createUser({ tenantId, cognitoSub: 'mech-me-pdf-ex' });
    const { customerId } = await createCustomer({ cognitoSub: 'cust-me-pdf-ex' });
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    await createOwnership({
      vehicleId,
      customerId,
      endedAt: new Date('2025-01-01T00:00:00.000Z'),
    });
    await seedShopIntervention({ tenantId, userId, vehicleId });

    const token = await signTestToken({ pool: 'clienti', sub: 'cust-me-pdf-ex', customerId });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${vehicleId}/export.pdf`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
    expect(generateVehicleHistoryPdfPresignedUrl).not.toHaveBeenCalled();
  });

  it('200 — cross-tenant history + cancelled excluded: forwards only active+disputed', async () => {
    // Vehicle owned by the customer, with interventions from TWO tenants plus a
    // cancelled one that must be excluded.
    const a = await createTenantWithLocation('me-pdf-xt-A');
    const b = await createTenantWithLocation('me-pdf-xt-B');
    const userA = await createUser({
      tenantId: a.tenantId,
      cognitoSub: 'mech-xtA',
    });
    const userB = await createUser({
      tenantId: b.tenantId,
      cognitoSub: 'mech-xtB',
    });
    const { customerId } = await createCustomer({ cognitoSub: 'cust-me-pdf-xt' });
    const { vehicleId } = await createVehicle({ createdByTenantId: a.tenantId });
    await createOwnership({ vehicleId, customerId });

    await seedShopIntervention({
      tenantId: a.tenantId,
      userId: userA.userId,
      vehicleId,
      date: '2026-01-10',
    });
    await seedShopIntervention({
      tenantId: b.tenantId,
      userId: userB.userId,
      vehicleId,
      date: '2026-03-10',
    });
    await seedShopIntervention({
      tenantId: a.tenantId,
      userId: userA.userId,
      vehicleId,
      date: '2026-04-10',
      status: 'cancelled',
    });

    const token = await signTestToken({ pool: 'clienti', sub: 'cust-me-pdf-xt', customerId });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${vehicleId}/export.pdf`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const data = vi.mocked(generateVehicleHistoryPdfPresignedUrl).mock.calls[0]![0].data;
    // Two non-cancelled interventions from two different tenants.
    expect(data.interventions).toHaveLength(2);
    const tenantNames = data.interventions.map((i) => i.tenantName);
    expect(new Set(tenantNames).size).toBe(2);
  });

  it('200 — vehicle with no shop interventions: empty history still generates a PDF', async () => {
    const { tenantId } = await createTenantWithLocation('me-pdf-empty');
    const { customerId } = await createCustomer({ cognitoSub: 'cust-me-pdf-empty' });
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    await createOwnership({ vehicleId, customerId });

    const token = await signTestToken({ pool: 'clienti', sub: 'cust-me-pdf-empty', customerId });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/vehicles/${vehicleId}/export.pdf`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(
      vi.mocked(generateVehicleHistoryPdfPresignedUrl).mock.calls[0]![0].data.interventions,
    ).toEqual([]);
  });
});
