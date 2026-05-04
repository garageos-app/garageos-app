import sensible from '@fastify/sensible';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
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

// Minimal in-memory mock of Prisma calls used by the handler. The route
// relies on:
//   - tx.user.findFirstOrThrow → returns { id }
//   - tx.intervention.findFirstOrThrow → throws P2025 if missing
//   - tx.attachment.create → returns the created row

interface MockTx {
  user: { findFirstOrThrow: ReturnType<typeof vi.fn> };
  intervention: { findFirstOrThrow: ReturnType<typeof vi.fn> };
  attachment: {
    create: ReturnType<typeof vi.fn>;
    findFirstOrThrow: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
}

function buildMockTx(overrides: Partial<MockTx> = {}): MockTx {
  return {
    user: {
      findFirstOrThrow: vi.fn().mockResolvedValue({ id: USER_ID }),
      ...overrides.user,
    },
    intervention: {
      findFirstOrThrow: vi.fn().mockResolvedValue({ id: INTERVENTION_ID }),
      ...overrides.intervention,
    },
    attachment: {
      create: vi.fn().mockResolvedValue({}),
      findFirstOrThrow: vi.fn(),
      update: vi.fn(),
      ...overrides.attachment,
    },
  };
}

function buildVerifier(pool: 'officine' | 'clienti' = 'officine'): JwtVerifier {
  return {
    verify: async (): Promise<VerifyResult> => ({
      pool,
      payload: {
        sub: COGNITO_SUB,
        token_use: 'id',
        'custom:tenant_id': TENANT_ID,
        'custom:role': 'super_admin',
      },
    }),
  };
}

async function buildApp(overrides: Partial<MockTx> = {}): Promise<{
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
  app.decorate('jwtVerifier', buildVerifier());
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

  it('rejects owner_type private_intervention with 422 attachment.upload.private_intervention_not_supported', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/attachments/upload-url',
      headers: { authorization: 'Bearer fake-token' },
      payload: { ...VALID_BODY, owner_type: 'private_intervention' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('attachment.upload.private_intervention_not_supported');
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
