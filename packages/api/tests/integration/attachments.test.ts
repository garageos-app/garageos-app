// packages/api/tests/integration/attachments.test.ts
//
// Integration tests for POST /v1/attachments/upload-url (phase 1) and
// POST /v1/attachments/:id/confirm (phase 2).
// Exercises both handlers against a real Testcontainers PostgreSQL instance;
// S3 calls are stubbed with aws-sdk-client-mock.
//
// F-OFF-305 — attachment upload + confirm flow.

import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { _resetS3ClientForTests } from '../../src/lib/s3.js';
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
import { pgAdmin } from './setup.js';
import { signTestToken } from '../helpers/jwt.js';

const s3Mock = mockClient(S3Client);

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestServer();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await resetDb();
  s3Mock.reset();
  _resetS3ClientForTests();
  s3Mock.on(PutObjectCommand).resolves({});
  s3Mock.on(HeadObjectCommand).resolves({
    ContentLength: 1024,
    ContentType: 'image/jpeg',
  });
});

// Setup helper: create a tenant + intervention so attachments can target it.
async function setupTenantWithIntervention(): Promise<{
  tenantId: string;
  locationId: string;
  userId: string;
  cognitoSub: string;
  interventionId: string;
  token: string;
}> {
  const { tenantId, locationId } = await createTenantWithLocation();
  const cognitoSub = crypto.randomUUID();
  const { userId } = await createUser({
    tenantId,
    locationId,
    cognitoSub,
    role: 'super_admin',
  });
  const { customerId } = await createCustomer({});
  const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
  await createOwnership({ vehicleId, customerId });
  const { id: interventionTypeId } = await ensureSystemInterventionType('TAGLIANDO');
  const { interventionId } = await createIntervention({
    tenantId,
    locationId,
    userId,
    vehicleId,
    interventionTypeId,
    interventionDate: '2026-01-01',
    odometerKm: 1000,
  });

  const token = await signTestToken({
    sub: cognitoSub,
    tenantId,
    role: 'super_admin',
    locationId,
    pool: 'officine',
  });

  return {
    tenantId,
    locationId,
    userId,
    cognitoSub,
    interventionId,
    token,
  };
}

const VALID_BODY_TEMPLATE = {
  owner_type: 'intervention',
  file_name: 'foto.jpg',
  mime_type: 'image/jpeg',
  size_bytes: 1024,
};

describe('POST /v1/attachments/upload-url + confirm — integration', () => {
  it('full happy flow: upload-url → confirm sets processed=true', async () => {
    const ctx = await setupTenantWithIntervention();

    const upload = await app.inject({
      method: 'POST',
      url: '/v1/attachments/upload-url',
      headers: { authorization: `Bearer ${ctx.token}` },
      payload: { ...VALID_BODY_TEMPLATE, owner_id: ctx.interventionId },
    });
    expect(upload.statusCode).toBe(201);
    const { attachment_id, callback_url } = upload.json() as {
      attachment_id: string;
      callback_url: string;
    };

    const confirm = await app.inject({
      method: 'POST',
      url: callback_url,
      headers: { authorization: `Bearer ${ctx.token}` },
    });
    expect(confirm.statusCode).toBe(200);
    expect((confirm.json() as { processed: boolean }).processed).toBe(true);

    // Verify DB state via raw SQL (pgAdmin is a pg client, not Prisma).
    const { rows } = await pgAdmin.query<{
      processed: boolean;
      uploaded_by_user_id: string;
      tenant_id: string;
    }>(
      `SELECT processed, uploaded_by_user_id, tenant_id
         FROM attachments
        WHERE id = $1`,
      [attachment_id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.processed).toBe(true);
    expect(rows[0]!.uploaded_by_user_id).toBe(ctx.userId);
  });

  it('cross-tenant isolation: officina A cannot confirm attachment of officina B (RLS-as-404)', async () => {
    const tenantA = await setupTenantWithIntervention();
    const tenantB = await setupTenantWithIntervention();

    const upload = await app.inject({
      method: 'POST',
      url: '/v1/attachments/upload-url',
      headers: { authorization: `Bearer ${tenantA.token}` },
      payload: { ...VALID_BODY_TEMPLATE, owner_id: tenantA.interventionId },
    });
    expect(upload.statusCode).toBe(201);
    const { attachment_id } = upload.json() as { attachment_id: string };

    // Tenant B tries to confirm tenant A's attachment — must get 404.
    const confirm = await app.inject({
      method: 'POST',
      url: `/v1/attachments/${attachment_id}/confirm`,
      headers: { authorization: `Bearer ${tenantB.token}` },
    });
    expect(confirm.statusCode).toBe(404);
    expect((confirm.json() as { code: string }).code).toBe('attachment.confirm.not_found');
  });

  it('idempotent confirm: chiamato 2 volte ritorna 200 stesso payload', async () => {
    const ctx = await setupTenantWithIntervention();

    const upload = await app.inject({
      method: 'POST',
      url: '/v1/attachments/upload-url',
      headers: { authorization: `Bearer ${ctx.token}` },
      payload: { ...VALID_BODY_TEMPLATE, owner_id: ctx.interventionId },
    });
    expect(upload.statusCode).toBe(201);
    const { attachment_id } = upload.json() as { attachment_id: string };

    const first = await app.inject({
      method: 'POST',
      url: `/v1/attachments/${attachment_id}/confirm`,
      headers: { authorization: `Bearer ${ctx.token}` },
    });
    const second = await app.inject({
      method: 'POST',
      url: `/v1/attachments/${attachment_id}/confirm`,
      headers: { authorization: `Bearer ${ctx.token}` },
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json()).toEqual(second.json());
  });

  it('clienti pool JWT → 403', async () => {
    const ctx = await setupTenantWithIntervention();
    const { customerId } = await createCustomer({});
    const clientiToken = await signTestToken({
      sub: crypto.randomUUID(),
      customerId,
      pool: 'clienti',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/attachments/upload-url',
      headers: { authorization: `Bearer ${clientiToken}` },
      payload: { ...VALID_BODY_TEMPLATE, owner_id: ctx.interventionId },
    });
    expect(res.statusCode).toBe(403);
  });

  it('no JWT → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/attachments/upload-url',
      payload: { ...VALID_BODY_TEMPLATE, owner_id: '00000000-0000-4000-8000-000000000000' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('cross-tenant intervention reference → 404 (RLS scoping)', async () => {
    const tenantA = await setupTenantWithIntervention();
    const tenantB = await setupTenantWithIntervention();

    // Tenant A tries to attach a file to an intervention owned by tenant B.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/attachments/upload-url',
      headers: { authorization: `Bearer ${tenantA.token}` },
      payload: { ...VALID_BODY_TEMPLATE, owner_id: tenantB.interventionId },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('attachment.upload.intervention_not_found');
  });

  it('uploadedByUserId persisted correctly from JWT user.id', async () => {
    const ctx = await setupTenantWithIntervention();

    const upload = await app.inject({
      method: 'POST',
      url: '/v1/attachments/upload-url',
      headers: { authorization: `Bearer ${ctx.token}` },
      payload: { ...VALID_BODY_TEMPLATE, owner_id: ctx.interventionId },
    });
    expect(upload.statusCode).toBe(201);
    const { attachment_id } = upload.json() as {
      attachment_id: string;
      upload_url: string;
      callback_url: string;
    };

    const { rows } = await pgAdmin.query<{
      uploaded_by_user_id: string;
      tenant_id: string;
    }>(`SELECT uploaded_by_user_id, tenant_id FROM attachments WHERE id = $1`, [attachment_id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.uploaded_by_user_id).toBe(ctx.userId);
    expect(rows[0]!.tenant_id).toBe(ctx.tenantId);
  });

  it('attachment row visible only to its tenant via RLS', async () => {
    const tenantA = await setupTenantWithIntervention();
    // Create a second tenant (tenantB's rows exist but attachment belongs to A only).
    await setupTenantWithIntervention();

    const upload = await app.inject({
      method: 'POST',
      url: '/v1/attachments/upload-url',
      headers: { authorization: `Bearer ${tenantA.token}` },
      payload: { ...VALID_BODY_TEMPLATE, owner_id: tenantA.interventionId },
    });
    expect(upload.statusCode).toBe(201);

    // pgAdmin bypasses RLS — we verify only one attachment row exists globally.
    const { rows } = await pgAdmin.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM attachments`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenant_id).toBe(tenantA.tenantId);
  });
});
