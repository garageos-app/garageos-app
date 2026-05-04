import { randomUUID } from 'node:crypto';

import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { _resetS3ClientForTests } from '../../src/lib/s3.js';
import { buildTestServer } from './fixtures.js';
import {
  createCustomer,
  createDispute,
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

const VALID_RESPONSE =
  "L'intervento è stato eseguito come da preventivo firmato il 2026-04-20; foglio di lavoro disponibile.";

describe('POST /v1/interventions/:id/dispute-response (F-OFF-602)', () => {
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
    s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 1024, ContentType: 'image/jpeg' });
  });

  it('200 happy path single dispute: persists tenant_response, flips intervention.status to active, writes access_log row', async () => {
    const { tenantId, locationId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({
      tenantId,
      cognitoSub,
      role: 'super_admin',
      locationId,
    });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { customerId } = await createCustomer({});
    await createOwnership({ vehicleId, customerId });
    const { interventionId } = await createIntervention({
      tenantId,
      locationId,
      userId,
      vehicleId,
      interventionTypeId: type.id,
      interventionDate: '2026-04-25',
      odometerKm: 50000,
      status: 'disputed',
    });
    const { disputeId } = await createDispute({
      interventionId,
      customerId,
      status: 'open',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
      locationId,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${interventionId}/dispute-response`,
      headers: { authorization: `Bearer ${token}` },
      payload: { tenantResponse: VALID_RESPONSE },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      disputes: Array<{
        id: string;
        status: string;
        tenantResponse: string;
        tenantResponseUserId: string;
      }>;
      interventionStatus: string;
    };
    expect(body.disputes).toHaveLength(1);
    expect(body.disputes[0]!.id).toBe(disputeId);
    expect(body.disputes[0]!.status).toBe('responded');
    expect(body.disputes[0]!.tenantResponse).toBe(VALID_RESPONSE);
    expect(body.disputes[0]!.tenantResponseUserId).toBe(userId);
    expect(body.interventionStatus).toBe('active');

    // DB persistence
    const { rows: disputeRows } = await pgAdmin.query<{
      status: string;
      tenant_response: string;
      tenant_response_at: string | null;
      tenant_response_user_id: string;
    }>(
      `SELECT status, tenant_response, tenant_response_at, tenant_response_user_id
         FROM intervention_disputes WHERE id = $1`,
      [disputeId],
    );
    expect(disputeRows[0]).toMatchObject({
      status: 'responded',
      tenant_response: VALID_RESPONSE,
      tenant_response_user_id: userId,
    });
    expect(disputeRows[0]!.tenant_response_at).not.toBeNull();

    const { rows: interventionRows } = await pgAdmin.query<{ status: string }>(
      'SELECT status FROM interventions WHERE id = $1',
      [interventionId],
    );
    expect(interventionRows[0]!.status).toBe('active');

    // BR-154 audit
    const { rows: logRows } = await pgAdmin.query<{ action: string; user_id: string }>(
      `SELECT action, user_id FROM access_logs
        WHERE vehicle_id = $1 AND action = 'respond'`,
      [vehicleId],
    );
    expect(logRows).toHaveLength(1);
    expect(logRows[0]!.user_id).toBe(userId);
  });

  it('200 multi-dispute fanout: 2 customers, both flipped to responded, intervention active', async () => {
    const { tenantId, locationId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({
      tenantId,
      cognitoSub,
      role: 'mechanic',
      locationId,
    });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { customerId: c1 } = await createCustomer({});
    const { customerId: c2 } = await createCustomer({});
    await createOwnership({ vehicleId, customerId: c1 });
    const { interventionId } = await createIntervention({
      tenantId,
      locationId,
      userId,
      vehicleId,
      interventionTypeId: type.id,
      interventionDate: '2026-04-25',
      odometerKm: 50000,
      status: 'disputed',
    });
    const { disputeId: d1 } = await createDispute({
      interventionId,
      customerId: c1,
      status: 'open',
    });
    const { disputeId: d2 } = await createDispute({
      interventionId,
      customerId: c2,
      status: 'open',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
      locationId,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${interventionId}/dispute-response`,
      headers: { authorization: `Bearer ${token}` },
      payload: { tenantResponse: VALID_RESPONSE },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      disputes: Array<{ id: string; status: string }>;
      interventionStatus: string;
    };
    expect(body.disputes.map((d) => d.id).sort()).toEqual([d1, d2].sort());
    expect(body.disputes.every((d) => d.status === 'responded')).toBe(true);
    expect(body.interventionStatus).toBe('active');

    const { rows } = await pgAdmin.query<{ status: string }>(
      'SELECT status FROM intervention_disputes WHERE intervention_id = $1 ORDER BY id',
      [interventionId],
    );
    expect(rows.map((r) => r.status)).toEqual(['responded', 'responded']);
  });

  it('200 residual open dispute (third customer) keeps intervention disputed', async () => {
    const { tenantId, locationId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({
      tenantId,
      cognitoSub,
      role: 'super_admin',
      locationId,
    });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { customerId: c1 } = await createCustomer({});
    const { customerId: c2 } = await createCustomer({});
    await createOwnership({ vehicleId, customerId: c1 });
    const { interventionId } = await createIntervention({
      tenantId,
      locationId,
      userId,
      vehicleId,
      interventionTypeId: type.id,
      interventionDate: '2026-04-25',
      odometerKm: 50000,
      status: 'disputed',
    });
    const { disputeId: target } = await createDispute({
      interventionId,
      customerId: c1,
      status: 'open',
    });
    const { disputeId: residual } = await createDispute({
      interventionId,
      customerId: c2,
      status: 'open',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
      locationId,
    });

    // Target only the first dispute via disputeId
    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${interventionId}/dispute-response`,
      headers: { authorization: `Bearer ${token}` },
      payload: { tenantResponse: VALID_RESPONSE, disputeId: target },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { interventionStatus: string };
    expect(body.interventionStatus).toBe('disputed');

    const { rows: residualRows } = await pgAdmin.query<{ status: string }>(
      'SELECT status FROM intervention_disputes WHERE id = $1',
      [residual],
    );
    expect(residualRows[0]!.status).toBe('open');

    const { rows: interventionRows } = await pgAdmin.query<{ status: string }>(
      'SELECT status FROM interventions WHERE id = $1',
      [interventionId],
    );
    expect(interventionRows[0]!.status).toBe('disputed');
  });

  it('access_log dedup: response to a second dispute within 30 min does NOT add another row', async () => {
    const { tenantId, locationId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({
      tenantId,
      cognitoSub,
      role: 'super_admin',
      locationId,
    });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { customerId: c1 } = await createCustomer({});
    const { customerId: c2 } = await createCustomer({});
    await createOwnership({ vehicleId, customerId: c1 });
    const { interventionId } = await createIntervention({
      tenantId,
      locationId,
      userId,
      vehicleId,
      interventionTypeId: type.id,
      interventionDate: '2026-04-25',
      odometerKm: 50000,
      status: 'disputed',
    });
    const { disputeId: d1 } = await createDispute({
      interventionId,
      customerId: c1,
      status: 'open',
    });
    const { disputeId: d2 } = await createDispute({
      interventionId,
      customerId: c2,
      status: 'open',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
      locationId,
    });

    // First response targets d1
    const res1 = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${interventionId}/dispute-response`,
      headers: { authorization: `Bearer ${token}` },
      payload: { tenantResponse: VALID_RESPONSE, disputeId: d1 },
    });
    expect(res1.statusCode).toBe(200);

    // Second response targets d2 (within 30 min)
    const res2 = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${interventionId}/dispute-response`,
      headers: { authorization: `Bearer ${token}` },
      payload: { tenantResponse: VALID_RESPONSE, disputeId: d2 },
    });
    expect(res2.statusCode).toBe(200);

    const { rows } = await pgAdmin.query<{ action: string }>(
      `SELECT action FROM access_logs
        WHERE vehicle_id = $1 AND user_id = $2`,
      [vehicleId, userId],
    );
    // The 30-min dedup key is (vehicleId, userId) — only 1 row total.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('respond');
  });

  it('cross-tenant isolation: officina B cannot respond to officina A dispute (disputes RLS blocks, returns 409)', async () => {
    // interventions_read is permissive (FOR SELECT USING (true)), so
    // findUniqueOrThrow succeeds for tenant B. The isolation is enforced
    // by intervention_disputes_access, which hides tenant A's disputes
    // from tenant B's context. findMany returns [] → 409 no_active_dispute.
    // The DB assertion confirms tenant A's dispute is untouched (still open).
    const a = await createTenantWithLocation('rls-a');
    const aSub = `office-a-${randomUUID().slice(0, 8)}`;
    const { userId: aUserId } = await createUser({
      tenantId: a.tenantId,
      cognitoSub: aSub,
      role: 'super_admin',
      locationId: a.locationId,
    });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: a.tenantId });
    const { customerId } = await createCustomer({});
    await createOwnership({ vehicleId, customerId });
    const { interventionId } = await createIntervention({
      tenantId: a.tenantId,
      locationId: a.locationId,
      userId: aUserId,
      vehicleId,
      interventionTypeId: type.id,
      interventionDate: '2026-04-25',
      odometerKm: 50000,
      status: 'disputed',
    });
    const { disputeId } = await createDispute({ interventionId, customerId, status: 'open' });

    const b = await createTenantWithLocation('rls-b');
    const bSub = `office-b-${randomUUID().slice(0, 8)}`;
    await createUser({
      tenantId: b.tenantId,
      cognitoSub: bSub,
      role: 'super_admin',
      locationId: b.locationId,
    });
    const token = await signTestToken({
      pool: 'officine',
      sub: bSub,
      tenantId: b.tenantId,
      role: 'super_admin',
      locationId: b.locationId,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${interventionId}/dispute-response`,
      headers: { authorization: `Bearer ${token}` },
      payload: { tenantResponse: VALID_RESPONSE },
    });
    // Disputes are invisible to tenant B → findMany returns [] → 409.
    // (interventions_read is permissive; isolation lives on disputes RLS.)
    expect(res.statusCode).toBe(409);
    const body = res.json() as { code: string };
    expect(body.code).toBe('intervention.dispute.response.no_active_dispute');

    // Sanity: tenant A's dispute is still open (not mutated by tenant B).
    const { rows } = await pgAdmin.query<{ status: string }>(
      'SELECT status FROM intervention_disputes WHERE id = $1',
      [disputeId],
    );
    expect(rows[0]!.status).toBe('open');
  });

  it('409 already responded: re-responding to the same dispute returns no_active_dispute', async () => {
    const { tenantId, locationId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({
      tenantId,
      cognitoSub,
      role: 'super_admin',
      locationId,
    });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { customerId } = await createCustomer({});
    await createOwnership({ vehicleId, customerId });
    const { interventionId } = await createIntervention({
      tenantId,
      locationId,
      userId,
      vehicleId,
      interventionTypeId: type.id,
      interventionDate: '2026-04-25',
      odometerKm: 50000,
      status: 'disputed',
    });
    const { disputeId } = await createDispute({
      interventionId,
      customerId,
      status: 'open',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
      locationId,
    });

    const first = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${interventionId}/dispute-response`,
      headers: { authorization: `Bearer ${token}` },
      payload: { tenantResponse: VALID_RESPONSE, disputeId: disputeId },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${interventionId}/dispute-response`,
      headers: { authorization: `Bearer ${token}` },
      payload: { tenantResponse: VALID_RESPONSE, disputeId: disputeId },
    });
    expect(second.statusCode).toBe(409);
    const body = second.json() as { code: string };
    expect(body.code).toBe('intervention.dispute.response.no_active_dispute');
  });

  it('PATCH unlock end-to-end: dispute-response then PATCH /interventions/:id succeeds', async () => {
    const { tenantId, locationId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({
      tenantId,
      cognitoSub,
      role: 'super_admin',
      locationId,
    });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { customerId } = await createCustomer({});
    await createOwnership({ vehicleId, customerId });
    const { interventionId } = await createIntervention({
      tenantId,
      locationId,
      userId,
      vehicleId,
      interventionTypeId: type.id,
      interventionDate: '2026-04-25',
      odometerKm: 50000,
      status: 'disputed',
      description: 'Tagliando completo',
    });
    await createDispute({ interventionId, customerId, status: 'open' });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
      locationId,
    });

    // Step 1: PATCH while disputed → 422 modification.disputed
    const patchPre = await app.inject({
      method: 'PATCH',
      url: `/v1/interventions/${interventionId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { description: 'Tagliando completo + filtro' },
    });
    expect(patchPre.statusCode).toBe(422);
    const preBody = patchPre.json() as { code: string };
    expect(preBody.code).toBe('intervention.modification.disputed');

    // Step 2: respond to dispute → unlocks PATCH
    const respond = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${interventionId}/dispute-response`,
      headers: { authorization: `Bearer ${token}` },
      payload: { tenantResponse: VALID_RESPONSE },
    });
    expect(respond.statusCode).toBe(200);
    const respondBody = respond.json() as { interventionStatus: string };
    expect(respondBody.interventionStatus).toBe('active');

    // Step 3: PATCH succeeds
    const patchPost = await app.inject({
      method: 'PATCH',
      url: `/v1/interventions/${interventionId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { description: 'Tagliando completo + filtro' },
    });
    expect(patchPost.statusCode).toBe(200);
    const postBody = patchPost.json() as { intervention: { description: string } };
    expect(postBody.intervention.description).toBe('Tagliando completo + filtro');
  });

  it('409 omitted disputeId on intervention with zero open disputes', async () => {
    const { tenantId, locationId } = await createTenantWithLocation();
    const cognitoSub = `office-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({
      tenantId,
      cognitoSub,
      role: 'super_admin',
      locationId,
    });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { interventionId } = await createIntervention({
      tenantId,
      locationId,
      userId,
      vehicleId,
      interventionTypeId: type.id,
      interventionDate: '2026-04-25',
      odometerKm: 50000,
      // no dispute → status active
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
      locationId,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${interventionId}/dispute-response`,
      headers: { authorization: `Bearer ${token}` },
      payload: { tenantResponse: VALID_RESPONSE },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { code: string };
    expect(body.code).toBe('intervention.dispute.response.no_active_dispute');
  });
});

describe('POST /v1/interventions/:id/dispute-response — attachments integration', () => {
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
    s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 1024, ContentType: 'image/jpeg' });
  });

  it('full flow: officina uploads response attachment → confirms → responds to dispute with attachmentIds', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('disp-resp-attach');
    const cognitoSub = `office-resp-${randomUUID().slice(0, 8)}`;
    const { userId } = await createUser({
      tenantId,
      cognitoSub,
      role: 'super_admin',
      locationId,
    });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { customerId } = await createCustomer({});
    await createOwnership({ vehicleId, customerId });
    const { interventionId } = await createIntervention({
      tenantId,
      locationId,
      userId,
      vehicleId,
      interventionTypeId: type.id,
      interventionDate: '2026-04-25',
      odometerKm: 50000,
      status: 'disputed',
    });
    const { disputeId } = await createDispute({ interventionId, customerId, status: 'open' });

    const offToken = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
      locationId,
    });

    // Step A: officina uploads a response attachment
    const upload = await app.inject({
      method: 'POST',
      url: '/v1/attachments/upload-url',
      headers: { authorization: `Bearer ${offToken}` },
      payload: {
        owner_type: 'intervention_dispute',
        owner_id: interventionId,
        file_name: 'risposta.jpg',
        mime_type: 'image/jpeg',
        size_bytes: 1024,
      },
    });
    expect(upload.statusCode).toBe(201);
    const { attachment_id, callback_url } = upload.json() as {
      attachment_id: string;
      callback_url: string;
    };

    // Verify: attachment row exists with correct fields
    const { rows: preRows } = await pgAdmin.query<{
      tenant_id: string;
      customer_id: string | null;
      uploaded_by_user_id: string;
      dispute_id: string | null;
      processed: boolean;
    }>(
      `SELECT tenant_id, customer_id, uploaded_by_user_id, dispute_id, processed
         FROM attachments WHERE id = $1`,
      [attachment_id],
    );
    expect(preRows).toHaveLength(1);
    expect(preRows[0]!.tenant_id).toBe(tenantId);
    expect(preRows[0]!.customer_id).toBeNull();
    expect(preRows[0]!.uploaded_by_user_id).toBe(userId);
    expect(preRows[0]!.dispute_id).toBeNull();
    expect(preRows[0]!.processed).toBe(false);

    // Step B: confirm the upload
    const confirm = await app.inject({
      method: 'POST',
      url: callback_url,
      headers: { authorization: `Bearer ${offToken}` },
    });
    expect(confirm.statusCode).toBe(200);
    expect((confirm.json() as { processed: boolean }).processed).toBe(true);

    // Step C: respond to the dispute with attachmentIds
    const respond = await app.inject({
      method: 'POST',
      url: `/v1/interventions/${interventionId}/dispute-response`,
      headers: { authorization: `Bearer ${offToken}` },
      payload: {
        tenantResponse: VALID_RESPONSE,
        disputeId,
        attachmentIds: [attachment_id],
      },
    });
    expect(respond.statusCode).toBe(200);
    const respondBody = respond.json() as {
      disputes: Array<{ id: string; attachment_ids: string[] }>;
      interventionStatus: string;
    };
    expect(respondBody.disputes).toHaveLength(1);
    expect(respondBody.disputes[0]!.id).toBe(disputeId);
    expect(respondBody.disputes[0]!.attachment_ids).toEqual([attachment_id]);
    expect(respondBody.interventionStatus).toBe('active');

    // Step D: Verify attachment.dispute_id === disputeId
    const { rows: claimedRows } = await pgAdmin.query<{ dispute_id: string | null }>(
      `SELECT dispute_id FROM attachments WHERE id = $1`,
      [attachment_id],
    );
    expect(claimedRows[0]!.dispute_id).toBe(disputeId);
  });

  it('422 no_open_dispute prevents officina upload when no dispute exists', async () => {
    const { tenantId, locationId } = await createTenantWithLocation('disp-no-dispute');
    const cognitoSub = `office-nodis-${randomUUID().slice(0, 8)}`;
    const { userId: _userId } = await createUser({
      tenantId,
      cognitoSub,
      role: 'super_admin',
      locationId,
    });
    const type = await ensureSystemInterventionType('TAGLIANDO');
    const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
    const { interventionId } = await createIntervention({
      tenantId,
      locationId,
      userId: _userId,
      vehicleId,
      interventionTypeId: type.id,
      interventionDate: '2026-04-25',
      odometerKm: 50000,
      // no dispute → status stays active
    });

    const offToken = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'super_admin',
      locationId,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/attachments/upload-url',
      headers: { authorization: `Bearer ${offToken}` },
      payload: {
        owner_type: 'intervention_dispute',
        owner_id: interventionId,
        file_name: 'risposta.jpg',
        mime_type: 'image/jpeg',
        size_bytes: 1024,
      },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe('attachment.upload.no_open_dispute');
  });
});
