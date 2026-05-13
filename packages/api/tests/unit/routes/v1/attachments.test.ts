import sensible from '@fastify/sensible';
import {
  HeadObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as s3Module from '../../../../src/lib/s3.js';
import { _resetS3ClientForTests, S3UnavailableError } from '../../../../src/lib/s3.js';
import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import type { JwtVerifier, VerifyResult } from '../../../../src/plugins/auth.js';
import attachmentsRoutes from '../../../../src/routes/v1/attachments.js';

const s3Mock = mockClient(S3Client);

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const INTERVENTION_ID = '55555555-5555-4555-8555-555555555555';
const COGNITO_SUB = '66666666-6666-4666-8666-666666666666';
const CUSTOMER_ID = '77777777-7777-4777-8777-777777777777';
const VEHICLE_ID = '88888888-8888-4888-8888-888888888888';

// Minimal in-memory mock of Prisma calls used by the handler. The route
// relies on:
//   - tx.user.findFirstOrThrow → returns { id }
//   - tx.intervention.findFirstOrThrow → throws P2025 if missing
//   - tx.attachment.create → returns the created row

interface MockTx {
  user: { findFirstOrThrow: ReturnType<typeof vi.fn> };
  intervention: {
    findFirstOrThrow: ReturnType<typeof vi.fn>;
    findUniqueOrThrow: ReturnType<typeof vi.fn>;
  };
  attachment: {
    create: ReturnType<typeof vi.fn>;
    findFirstOrThrow: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  vehicleOwnership: { findFirst: ReturnType<typeof vi.fn> };
  interventionDispute: { findFirst: ReturnType<typeof vi.fn> };
  privateIntervention: { findFirst: ReturnType<typeof vi.fn> };
}

function buildMockTx(overrides: Partial<MockTx> = {}): MockTx {
  return {
    user: {
      findFirstOrThrow: vi.fn().mockResolvedValue({ id: USER_ID, role: 'super_admin' }),
      ...overrides.user,
    },
    intervention: {
      findFirstOrThrow: vi
        .fn()
        .mockResolvedValue({ id: INTERVENTION_ID, tenantId: TENANT_ID, vehicleId: VEHICLE_ID }),
      findUniqueOrThrow: vi
        .fn()
        .mockResolvedValue({ id: INTERVENTION_ID, tenantId: TENANT_ID, vehicleId: VEHICLE_ID }),
      ...overrides.intervention,
    },
    attachment: {
      create: vi.fn().mockResolvedValue({}),
      findFirstOrThrow: vi.fn(),
      update: vi.fn(),
      ...overrides.attachment,
    },
    vehicleOwnership: {
      findFirst: vi.fn().mockResolvedValue({ id: 'own-1' }),
      ...overrides.vehicleOwnership,
    },
    interventionDispute: {
      findFirst: vi.fn().mockResolvedValue({ id: 'd-1' }),
      ...overrides.interventionDispute,
    },
    privateIntervention: {
      findFirst: vi.fn().mockResolvedValue({ id: INTERVENTION_ID }),
      ...overrides.privateIntervention,
    },
  };
}

function buildVerifier(pool: 'officine' | 'clienti' = 'officine'): JwtVerifier {
  return {
    verify: async (): Promise<VerifyResult> => ({
      pool,
      payload:
        pool === 'officine'
          ? {
              sub: COGNITO_SUB,
              token_use: 'id',
              'custom:tenant_id': TENANT_ID,
              'custom:role': 'super_admin',
            }
          : {
              sub: COGNITO_SUB,
              token_use: 'id',
              'custom:customer_id': CUSTOMER_ID,
            },
    }),
  };
}

async function buildApp(
  overrides: Partial<MockTx> = {},
  pool: 'officine' | 'clienti' = 'officine',
): Promise<{
  app: FastifyInstance;
  mockTx: MockTx;
}> {
  const mockTx = buildMockTx(overrides);
  const withContext = vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(mockTx));

  const app = Fastify({ logger: false });
  await app.register(sensible);
  registerErrorHandler(app);
  await app.register(databasePlugin, {
    prisma: mockTx as never,
    withContext: withContext as never,
  });
  app.decorate('jwtVerifier', buildVerifier(pool));
  await app.register(attachmentsRoutes);
  await app.ready();

  return { app, mockTx };
}

let app: FastifyInstance;
let mockTx: MockTx;

beforeEach(async () => {
  s3Mock.reset();
  _resetS3ClientForTests();
  s3Mock.on(PutObjectCommand).resolves({});

  ({ app, mockTx } = await buildApp());
});

afterEach(async () => {
  await app.close();
});

const VALID_BODY = {
  owner_type: 'intervention',
  owner_id: '00000000-0000-4000-8000-000000000000',
  file_name: 'foto-prima.jpg',
  mime_type: 'image/jpeg',
  size_bytes: 2_457_600,
};

describe('POST /v1/attachments/upload-url', () => {
  it('returns 201 with all expected response fields on happy path', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/attachments/upload-url',
      headers: { authorization: 'Bearer fake-token' },
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.attachment_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.upload_url).toContain('X-Amz-Signature=');
    expect(body.upload_method).toBe('PUT');
    expect(body.upload_headers).toEqual({ 'Content-Type': 'image/jpeg' });
    expect(body.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(body.callback_url).toBe(`/v1/attachments/${body.attachment_id}/confirm`);
  });

  it('rejects mime_type outside whitelist with 400 (Zod enum)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/attachments/upload-url',
      headers: { authorization: 'Bearer fake-token' },
      payload: { ...VALID_BODY, mime_type: 'text/html' },
    });
    expect(res.statusCode).toBe(400); // Zod enum mismatch → 400 VALIDATION_ERROR
  });

  it('rejects size_bytes > 25MB with 400 (Zod max constraint)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/attachments/upload-url',
      headers: { authorization: 'Bearer fake-token' },
      payload: { ...VALID_BODY, size_bytes: 26_214_401 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects empty file_name with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/attachments/upload-url',
      headers: { authorization: 'Bearer fake-token' },
      payload: { ...VALID_BODY, file_name: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects file_name with control bytes with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/attachments/upload-url',
      headers: { authorization: 'Bearer fake-token' },
      payload: { ...VALID_BODY, file_name: 'foo\x00bar.jpg' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects intervention not found (P2025) with 404 attachment.upload.intervention_not_found', async () => {
    const p2025 = Object.assign(new Error('P2025'), { code: 'P2025' });
    mockTx.intervention.findFirstOrThrow = vi.fn().mockRejectedValue(p2025);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/attachments/upload-url',
      headers: { authorization: 'Bearer fake-token' },
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('attachment.upload.intervention_not_found');
  });

  it('rejects officina pool with owner_type=private_intervention → 403 attachment.upload.officina_pool_not_allowed_for_private', async () => {
    // F-OFF-305 reciprocal: private_intervention is clienti-pool only.
    // Officina pool attempting upload returns 403 with the dedicated error code.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/attachments/upload-url',
      headers: { authorization: 'Bearer fake-token' },
      payload: { ...VALID_BODY, owner_type: 'private_intervention' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('attachment.upload.officina_pool_not_allowed_for_private');
  });

  it('s3 sdk failure → 502 attachment.upload.s3_unavailable', async () => {
    // getSignedUrl performs local signing and is not interceptable via
    // aws-sdk-client-mock. Spy directly on presignPutObject to simulate
    // an S3UnavailableError — the same error presignPutObject wraps all
    // real SDK failures into, which the route handler maps to 502.
    const spy = vi
      .spyOn(s3Module, 'presignPutObject')
      .mockRejectedValueOnce(new S3UnavailableError('Simulated SDK failure'));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/attachments/upload-url',
      headers: { authorization: 'Bearer fake-token' },
      payload: VALID_BODY,
    });
    spy.mockRestore();
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe('attachment.upload.s3_unavailable');
  });

  it('derives s3Key with correct extension per mime_type', async () => {
    // Rebuild app with a custom attachment.create mock that inspects s3Key.
    await app.close();
    const { app: freshApp, mockTx: freshTx } = await buildApp();
    app = freshApp;
    mockTx = freshTx;

    // image/png → .png
    mockTx.attachment.create = vi
      .fn()
      .mockImplementation(({ data }: { data: { s3Key: string } }) => {
        expect(data.s3Key).toMatch(/\.png$/);
        return Promise.resolve(data);
      });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/attachments/upload-url',
      headers: { authorization: 'Bearer fake-token' },
      payload: { ...VALID_BODY, mime_type: 'image/png', file_name: 'foo.png' },
    });
    expect(res.statusCode).toBe(201);
    expect(mockTx.attachment.create).toHaveBeenCalled();
  });
});

describe('POST /v1/attachments/:id/confirm', () => {
  // UUID must satisfy Zod z.string().uuid(): version nibble [1-8], variant [89abAB].
  const ATTACHMENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const PROCESSED_ATTACHMENT = {
    id: ATTACHMENT_ID,
    ownerType: 'intervention' as const,
    ownerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    tenantId: 'tenant-test',
    uploadedByUserId: USER_ID, // must match user.findFirstOrThrow mock return
    fileName: 'foto.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 1024,
    s3Key: 'attachments/intervention/.../uuid.jpg',
    s3Bucket: 'test-bucket',
    processed: false,
    createdAt: new Date('2026-05-04T12:00:00Z'),
  };

  it('flips processed: true and returns 200 on happy path', async () => {
    mockTx.attachment.findFirstOrThrow = vi.fn().mockResolvedValue(PROCESSED_ATTACHMENT);
    mockTx.attachment.update = vi.fn().mockResolvedValue({
      ...PROCESSED_ATTACHMENT,
      processed: true,
    });
    s3Mock.on(HeadObjectCommand).resolves({
      ContentLength: 1024,
      ContentType: 'image/jpeg',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/attachments/${ATTACHMENT_ID}/confirm`,
      headers: { authorization: 'Bearer fake-token' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: ATTACHMENT_ID,
      processed: true,
    });
    expect(mockTx.attachment.update).toHaveBeenCalledWith({
      where: { id: ATTACHMENT_ID },
      data: { processed: true },
    });
  });

  it('idempotent: returns 200 without S3 call when already processed', async () => {
    mockTx.attachment.findFirstOrThrow = vi.fn().mockResolvedValue({
      ...PROCESSED_ATTACHMENT,
      processed: true,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/attachments/${ATTACHMENT_ID}/confirm`,
      headers: { authorization: 'Bearer fake-token' },
    });
    expect(res.statusCode).toBe(200);
    expect(s3Mock.commandCalls(HeadObjectCommand)).toHaveLength(0);
    expect(mockTx.attachment.update).not.toHaveBeenCalled();
  });

  it('returns 404 attachment.confirm.not_found when attachment missing (P2025)', async () => {
    const p2025 = Object.assign(new Error('P2025'), { code: 'P2025' });
    mockTx.attachment.findFirstOrThrow = vi.fn().mockRejectedValue(p2025);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/attachments/${ATTACHMENT_ID}/confirm`,
      headers: { authorization: 'Bearer fake-token' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('attachment.confirm.not_found');
  });

  it('returns 403 attachment.confirm.not_uploader on uploader mismatch', async () => {
    mockTx.attachment.findFirstOrThrow = vi.fn().mockResolvedValue({
      ...PROCESSED_ATTACHMENT,
      uploadedByUserId: 'someone-else-id',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/attachments/${ATTACHMENT_ID}/confirm`,
      headers: { authorization: 'Bearer fake-token' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('attachment.confirm.not_uploader');
  });

  it('returns 422 attachment.confirm.upload_not_found when S3 NoSuchKey', async () => {
    mockTx.attachment.findFirstOrThrow = vi.fn().mockResolvedValue(PROCESSED_ATTACHMENT);
    s3Mock
      .on(HeadObjectCommand)
      .rejects(new NoSuchKey({ message: 'Not Found', $metadata: { httpStatusCode: 404 } }));

    const res = await app.inject({
      method: 'POST',
      url: `/v1/attachments/${ATTACHMENT_ID}/confirm`,
      headers: { authorization: 'Bearer fake-token' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('attachment.confirm.upload_not_found');
  });

  it('returns 422 attachment.confirm.metadata_mismatch on ContentLength mismatch', async () => {
    mockTx.attachment.findFirstOrThrow = vi.fn().mockResolvedValue(PROCESSED_ATTACHMENT);
    s3Mock.on(HeadObjectCommand).resolves({
      ContentLength: 9999, // attachment had sizeBytes 1024
      ContentType: 'image/jpeg',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/attachments/${ATTACHMENT_ID}/confirm`,
      headers: { authorization: 'Bearer fake-token' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('attachment.confirm.metadata_mismatch');
  });

  it('returns 422 attachment.confirm.metadata_mismatch on ContentType mismatch', async () => {
    mockTx.attachment.findFirstOrThrow = vi.fn().mockResolvedValue(PROCESSED_ATTACHMENT);
    s3Mock.on(HeadObjectCommand).resolves({
      ContentLength: 1024,
      ContentType: 'image/png', // attachment had mimeType image/jpeg
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/attachments/${ATTACHMENT_ID}/confirm`,
      headers: { authorization: 'Bearer fake-token' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('attachment.confirm.metadata_mismatch');
  });

  it('returns 502 attachment.confirm.s3_unavailable on generic S3 error', async () => {
    mockTx.attachment.findFirstOrThrow = vi.fn().mockResolvedValue(PROCESSED_ATTACHMENT);
    // Use S3ServiceException with 500 status (not 404 → would be ObjectNotFound).
    s3Mock.on(HeadObjectCommand).rejects(
      new S3ServiceException({
        name: 'InternalError',
        $fault: 'server',
        $metadata: { httpStatusCode: 500 },
        message: 'Internal Error',
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: `/v1/attachments/${ATTACHMENT_ID}/confirm`,
      headers: { authorization: 'Bearer fake-token' },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe('attachment.confirm.s3_unavailable');
  });
});

// ---------------------------------------------------------------------------
// NEW: intervention_dispute cross-pool tests (Task 7)
// ---------------------------------------------------------------------------

describe('POST /v1/attachments/upload-url — intervention_dispute customer-pool', () => {
  const DISPUTE_BODY = {
    owner_type: 'intervention_dispute',
    owner_id: INTERVENTION_ID,
    file_name: 'prova-disputa.jpg',
    mime_type: 'image/jpeg',
    size_bytes: 1_000_000,
  };

  let clientiApp: FastifyInstance;
  let clientiTx: MockTx;

  beforeEach(async () => {
    s3Mock.reset();
    _resetS3ClientForTests();
    s3Mock.on(PutObjectCommand).resolves({});
    ({ app: clientiApp, mockTx: clientiTx } = await buildApp({}, 'clienti'));
  });

  afterEach(async () => {
    await clientiApp.close();
  });

  it('happy path: returns 201 and creates attachment with customer ownership', async () => {
    const res = await clientiApp.inject({
      method: 'POST',
      url: '/v1/attachments/upload-url',
      headers: { authorization: 'Bearer fake-token' },
      payload: DISPUTE_BODY,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.attachment_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.upload_url).toContain('X-Amz-Signature=');
    // attachment.create must be called with intervention_dispute ownership
    expect(clientiTx.attachment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ownerType: 'intervention_dispute',
          customerId: CUSTOMER_ID,
          uploadedByCustomerId: CUSTOMER_ID,
        }),
      }),
    );
  });

  it('returns 403 attachment.upload.intervention_dispute_not_owner when vehicleOwnership missing', async () => {
    clientiTx.vehicleOwnership.findFirst = vi.fn().mockResolvedValue(null);

    const res = await clientiApp.inject({
      method: 'POST',
      url: '/v1/attachments/upload-url',
      headers: { authorization: 'Bearer fake-token' },
      payload: DISPUTE_BODY,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('attachment.upload.intervention_dispute_not_owner');
  });

  it('returns 404 attachment.upload.intervention_not_found when intervention P2025', async () => {
    const p2025 = Object.assign(new Error('P2025'), { code: 'P2025' });
    clientiTx.intervention.findUniqueOrThrow = vi.fn().mockRejectedValue(p2025);

    const res = await clientiApp.inject({
      method: 'POST',
      url: '/v1/attachments/upload-url',
      headers: { authorization: 'Bearer fake-token' },
      payload: DISPUTE_BODY,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('attachment.upload.intervention_not_found');
  });
});

describe('POST /v1/attachments/upload-url — intervention_dispute officina-pool', () => {
  const DISPUTE_BODY = {
    owner_type: 'intervention_dispute',
    owner_id: INTERVENTION_ID,
    file_name: 'officina-disputa.pdf',
    mime_type: 'application/pdf',
    size_bytes: 500_000,
  };

  it('happy path: returns 201 and creates attachment with officina ownership (customerId null)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/attachments/upload-url',
      headers: { authorization: 'Bearer fake-token' },
      payload: DISPUTE_BODY,
    });
    expect(res.statusCode).toBe(201);
    expect(mockTx.attachment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ownerType: 'intervention_dispute',
          customerId: null,
          uploadedByUserId: USER_ID,
          uploadedByCustomerId: null,
        }),
      }),
    );
  });

  it('returns 403 attachment.upload.intervention_dispute_role_denied when user has unsupported role', async () => {
    // Force an unsupported role via the user mock — the handler checks
    // role at application layer, not via Zod, so any non-allowed string works.
    mockTx.user.findFirstOrThrow = vi
      .fn()
      .mockResolvedValue({ id: USER_ID, role: 'viewer' as never });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/attachments/upload-url',
      headers: { authorization: 'Bearer fake-token' },
      payload: DISPUTE_BODY,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('attachment.upload.intervention_dispute_role_denied');
  });

  it('returns 422 attachment.upload.no_open_dispute when no open dispute exists', async () => {
    mockTx.interventionDispute.findFirst = vi.fn().mockResolvedValue(null);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/attachments/upload-url',
      headers: { authorization: 'Bearer fake-token' },
      payload: DISPUTE_BODY,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('attachment.upload.no_open_dispute');
  });
});

describe('POST /v1/attachments/upload-url — intervention pool gate', () => {
  it('returns 403 attachment.upload.officina_only when clienti pool sends intervention owner_type', async () => {
    const { app: clientiApp } = await buildApp({}, 'clienti');

    const res = await clientiApp.inject({
      method: 'POST',
      url: '/v1/attachments/upload-url',
      headers: { authorization: 'Bearer fake-token' },
      payload: {
        owner_type: 'intervention',
        owner_id: INTERVENTION_ID,
        file_name: 'foto.jpg',
        mime_type: 'image/jpeg',
        size_bytes: 1_000_000,
      },
    });
    await clientiApp.close();
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('attachment.upload.officina_only');
  });
});

// ---------------------------------------------------------------------------
// F2: private_intervention dispatch tests
//
// The reciprocal officina-pool 403 case is already covered by the test at
// line ~222 ("rejects officina pool with owner_type=private_intervention →
// 403 attachment.upload.officina_pool_not_allowed_for_private"). Only the
// clienti happy-path dispatch is added here.
// ---------------------------------------------------------------------------

describe('POST /v1/attachments/upload-url — private_intervention clienti dispatch', () => {
  const PRIVATE_ID = '99999999-9999-4999-8999-999999999999';
  const PRIVATE_BODY = {
    owner_type: 'private_intervention',
    owner_id: PRIVATE_ID,
    file_name: 'x.jpg',
    mime_type: 'image/jpeg',
    size_bytes: 1_000,
  };

  it('upload-url dispatches owner_type=private_intervention to private handler for clienti pool', async () => {
    const { app: clientiApp, mockTx: clientiTx } = await buildApp({}, 'clienti');

    const res = await clientiApp.inject({
      method: 'POST',
      url: '/v1/attachments/upload-url',
      headers: { authorization: 'Bearer fake-token' },
      payload: PRIVATE_BODY,
    });
    await clientiApp.close();

    expect(res.statusCode).toBe(201);
    // Verify the private-intervention scoped lookup ran with the
    // customerId from the clienti JWT and the soft-delete filter.
    expect(clientiTx.privateIntervention.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: PRIVATE_ID,
          customerId: CUSTOMER_ID,
          deletedAt: null,
        }),
      }),
    );
    // Pin the polymorphic ownership shape so a typo in any field is
    // caught at unit-test time, not at chk_attachment_owner_consistent.
    expect(clientiTx.attachment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ownerType: 'private_intervention',
          tenantId: null,
          customerId: CUSTOMER_ID,
          uploadedByCustomerId: CUSTOMER_ID,
          uploadedByUserId: null,
        }),
      }),
    );
  });
});

describe('POST /v1/attachments/:id/confirm — cross-pool', () => {
  const ATTACHMENT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

  it('customer-pool confirm happy path: returns 200 when uploadedByCustomerId matches', async () => {
    const { app: clientiApp, mockTx: clientiTx } = await buildApp({}, 'clienti');

    const attachment = {
      id: ATTACHMENT_ID,
      ownerType: 'intervention_dispute' as const,
      ownerId: INTERVENTION_ID,
      tenantId: TENANT_ID,
      uploadedByCustomerId: CUSTOMER_ID,
      uploadedByUserId: null,
      fileName: 'prova.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 1024,
      s3Key: 'attachments/intervention_dispute/xxx/uuid.jpg',
      s3Bucket: 'test-bucket',
      processed: true, // already processed → idempotent, no S3 call needed
      createdAt: new Date('2026-05-04T12:00:00Z'),
    };
    clientiTx.attachment.findFirstOrThrow = vi.fn().mockResolvedValue(attachment);

    const res = await clientiApp.inject({
      method: 'POST',
      url: `/v1/attachments/${ATTACHMENT_ID}/confirm`,
      headers: { authorization: 'Bearer fake-token' },
    });
    await clientiApp.close();
    expect(res.statusCode).toBe(200);
  });

  it('customer-pool confirm returns 403 attachment.confirm.not_uploader when uploadedByCustomerId mismatch', async () => {
    const { app: clientiApp2, mockTx: clientiTx2 } = await buildApp({}, 'clienti');

    clientiTx2.attachment.findFirstOrThrow = vi.fn().mockResolvedValue({
      id: ATTACHMENT_ID,
      ownerType: 'intervention_dispute' as const,
      ownerId: INTERVENTION_ID,
      tenantId: TENANT_ID,
      uploadedByCustomerId: 'other-customer-id',
      uploadedByUserId: null,
      fileName: 'prova.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 1024,
      s3Key: 'attachments/intervention_dispute/xxx/uuid.jpg',
      s3Bucket: 'test-bucket',
      processed: false,
      createdAt: new Date('2026-05-04T12:00:00Z'),
    });

    const res = await clientiApp2.inject({
      method: 'POST',
      url: `/v1/attachments/${ATTACHMENT_ID}/confirm`,
      headers: { authorization: 'Bearer fake-token' },
    });
    await clientiApp2.close();
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('attachment.confirm.not_uploader');
  });

  it('customer-pool confirm: processed=false → HeadObject → flip to processed=true', async () => {
    const FULL_S3_ATTACHMENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    ({ app, mockTx } = await buildApp(
      {
        attachment: {
          create: vi.fn(),
          findFirstOrThrow: vi.fn().mockResolvedValue({
            id: FULL_S3_ATTACHMENT_ID,
            ownerType: 'intervention_dispute',
            ownerId: INTERVENTION_ID,
            tenantId: TENANT_ID,
            uploadedByCustomerId: CUSTOMER_ID,
            uploadedByUserId: null,
            fileName: 'foto.jpg',
            mimeType: 'image/jpeg',
            sizeBytes: 1024,
            s3Key: 'k',
            s3Bucket: 'b',
            processed: false, // <- not yet confirmed
            createdAt: new Date(),
          }),
          update: vi.fn().mockResolvedValue({
            id: FULL_S3_ATTACHMENT_ID,
            ownerType: 'intervention_dispute',
            ownerId: INTERVENTION_ID,
            tenantId: TENANT_ID,
            uploadedByCustomerId: CUSTOMER_ID,
            uploadedByUserId: null,
            fileName: 'foto.jpg',
            mimeType: 'image/jpeg',
            sizeBytes: 1024,
            s3Key: 'k',
            s3Bucket: 'b',
            processed: true, // <- after flip
            createdAt: new Date(),
          }),
        },
      },
      'clienti',
    ));

    s3Mock.on(HeadObjectCommand).resolves({
      ContentLength: 1024,
      ContentType: 'image/jpeg',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/attachments/${FULL_S3_ATTACHMENT_ID}/confirm`,
      headers: { authorization: 'Bearer fake-token' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.processed).toBe(true);
    expect(mockTx.attachment.update).toHaveBeenCalledWith({
      where: { id: FULL_S3_ATTACHMENT_ID },
      data: { processed: true },
    });
  });

  it('officine-pool confirm not_uploader: 403 when uploadedByUserId mismatch', async () => {
    const OFFICINE_ATTACHMENT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const OTHER_USER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    ({ app, mockTx } = await buildApp(
      {
        user: {
          findFirstOrThrow: vi.fn().mockResolvedValue({ id: USER_ID }),
        },
        attachment: {
          create: vi.fn(),
          findFirstOrThrow: vi.fn().mockResolvedValue({
            id: OFFICINE_ATTACHMENT_ID,
            ownerType: 'intervention_dispute',
            ownerId: INTERVENTION_ID,
            tenantId: TENANT_ID,
            uploadedByCustomerId: null,
            uploadedByUserId: OTHER_USER_ID, // <- different user
            fileName: 'foto.jpg',
            mimeType: 'image/jpeg',
            sizeBytes: 1024,
            s3Key: 'k',
            s3Bucket: 'b',
            processed: false,
            createdAt: new Date(),
          }),
          update: vi.fn(),
        },
      },
      'officine',
    ));

    const res = await app.inject({
      method: 'POST',
      url: `/v1/attachments/${OFFICINE_ATTACHMENT_ID}/confirm`,
      headers: { authorization: 'Bearer fake-token' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('attachment.confirm.not_uploader');
  });
});
