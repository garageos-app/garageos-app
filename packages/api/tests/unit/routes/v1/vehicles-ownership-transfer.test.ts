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
import { vehiclesOwnershipTransferRoutes } from '../../../../src/routes/v1/vehicles-ownership-transfer.js';

const s3Mock = mockClient(S3Client);

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const COGNITO_SUB = '66666666-6666-4666-8666-666666666666';
const VEHICLE_ID = '88888888-8888-4888-8888-888888888888';

interface MockTx {
  user: { findFirst: ReturnType<typeof vi.fn>; findFirstOrThrow: ReturnType<typeof vi.fn> };
  vehicle: { findFirst: ReturnType<typeof vi.fn>; findUniqueOrThrow: ReturnType<typeof vi.fn> };
}

function buildMockTx(overrides: Partial<MockTx> = {}): MockTx {
  return {
    user: {
      findFirst: vi.fn().mockResolvedValue({ id: 'user-db-id' }),
      findFirstOrThrow: vi.fn().mockResolvedValue({ id: 'user-db-id' }),
      ...overrides.user,
    },
    vehicle: {
      findFirst: vi.fn().mockResolvedValue({ id: VEHICLE_ID }),
      findUniqueOrThrow: vi.fn(),
      ...overrides.vehicle,
    },
  };
}

function buildVerifier(): JwtVerifier {
  return {
    verify: async (): Promise<VerifyResult> => ({
      pool: 'officine',
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
  await app.register(vehiclesOwnershipTransferRoutes);
  await app.ready();
  return { app, mockTx };
}

let app: FastifyInstance;

beforeEach(async () => {
  s3Mock.reset();
  _resetS3ClientForTests();
  s3Mock.on(PutObjectCommand).resolves({});
  ({ app } = await buildApp());
});

afterEach(async () => {
  await app.close();
});

const URL = `/v1/vehicles/${VEHICLE_ID}/ownership-transfer/document-upload-url`;
const VALID_BODY = {
  fileName: 'libretto.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 1_048_576,
};

describe('POST /v1/vehicles/:id/ownership-transfer/document-upload-url', () => {
  it('returns 200 with a presigned PUT URL and a vehicle-transfers/ key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: URL,
      headers: { authorization: 'Bearer fake-token' },
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.uploadUrl).toContain('X-Amz-Signature=');
    expect(body.uploadMethod).toBe('PUT');
    expect(body.uploadHeaders).toEqual({ 'Content-Type': 'application/pdf' });
    expect(body.s3Key).toMatch(new RegExp(`^vehicle-transfers/${VEHICLE_ID}/[0-9a-f-]{36}\\.pdf$`));
    expect(body.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('rejects a mime type outside the whitelist with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: URL,
      headers: { authorization: 'Bearer fake-token' },
      payload: { ...VALID_BODY, mimeType: 'image/webp' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects sizeBytes over 10 MB with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: URL,
      headers: { authorization: 'Bearer fake-token' },
      payload: { ...VALID_BODY, sizeBytes: 10 * 1024 * 1024 + 1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 vehicle.not_found when the vehicle is not visible to the tenant', async () => {
    await app.close();
    ({ app } = await buildApp({
      vehicle: { findFirst: vi.fn().mockResolvedValue(null), findUniqueOrThrow: vi.fn() },
    }));
    const res = await app.inject({
      method: 'POST',
      url: URL,
      headers: { authorization: 'Bearer fake-token' },
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('vehicle.not_found');
  });

  it('maps S3UnavailableError to 502 vehicle.transfer.document_s3_unavailable', async () => {
    const spy = vi
      .spyOn(s3Module, 'presignPutObject')
      .mockRejectedValueOnce(new S3UnavailableError('Simulated SDK failure'));
    const res = await app.inject({
      method: 'POST',
      url: URL,
      headers: { authorization: 'Bearer fake-token' },
      payload: VALID_BODY,
    });
    spy.mockRestore();
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe('vehicle.transfer.document_s3_unavailable');
  });

  it('derives the .jpg extension from image/jpeg', async () => {
    const res = await app.inject({
      method: 'POST',
      url: URL,
      headers: { authorization: 'Bearer fake-token' },
      payload: { fileName: 'libretto.jpg', mimeType: 'image/jpeg', sizeBytes: 2_000_000 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().s3Key).toMatch(/\.jpg$/);
  });
});
