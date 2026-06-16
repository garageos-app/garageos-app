import sensible from '@fastify/sensible';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as dispatcherModule from '../../../../src/lib/notifications/dispatcher.js';

import * as s3Module from '../../../../src/lib/s3.js';
import {
  S3ObjectNotFoundError,
  _resetS3ClientForTests,
  S3UnavailableError,
} from '../../../../src/lib/s3.js';
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

// ─── Transfer route tests (Task 5 — documentS3Key validation) ───────────────

// Reuse the FakePrisma stub shape from the lib test so the tx passed to
// withContext has all the groups performOwnershipTransfer touches.

const CURRENT_OWNER_ID = '11111111-1111-4111-8111-aaaaaaaaaaaa';
const RECIPIENT_ID = '22222222-2222-4222-8222-222222222222';

interface TransferStubCustomer {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  isBusiness: boolean;
  businessName: string | null;
  notificationPreferences: unknown;
  status: 'active' | 'pending_verification' | 'deleted';
}

interface MakeTransferStubOptions {
  cedenteStatus?: 'active' | 'pending_verification' | 'deleted';
}

function makeTransferStub(options: MakeTransferStubOptions = {}) {
  const { cedenteStatus = 'active' } = options;

  // in-memory state
  const vehicles = new Map<
    string,
    {
      id: string;
      certifiedByTenantId: string | null;
      createdByTenantId: string | null;
      status: string;
      plate: string;
    }
  >();
  const ownerships = new Map<
    string,
    { id: string; vehicleId: string; customerId: string; endedAt: Date | null }
  >();
  const transfers = new Map<string, { id: string; vehicleId: string; status: string }>();
  const customers = new Map<string, TransferStubCustomer>();
  const relations = new Map<
    string,
    { tenantId: string; customerId: string; interventionCount: number }
  >();
  const accessLogs: { tenantId: string; vehicleId: string; userId: string; action: string }[] = [];
  const tenants = new Map<string, { id: string; businessName: string }>();

  // Seed a certified vehicle belonging to TENANT_ID
  vehicles.set(VEHICLE_ID, {
    id: VEHICLE_ID,
    certifiedByTenantId: TENANT_ID,
    createdByTenantId: TENANT_ID,
    status: 'certified',
    plate: 'AB123CD',
  });
  // Seed current ownership (cedente ≠ recipient)
  ownerships.set('own-current', {
    id: 'own-current',
    vehicleId: VEHICLE_ID,
    customerId: CURRENT_OWNER_ID,
    endedAt: null,
  });
  // Seed cedente customer — status controlled by caller
  customers.set(CURRENT_OWNER_ID, {
    id: CURRENT_OWNER_ID,
    email: 'cedente@example.com',
    firstName: 'Cedente',
    lastName: 'Test',
    isBusiness: false,
    businessName: null,
    notificationPreferences: { ownership_transfer: true },
    status: cedenteStatus,
  });
  // Seed recipient customer
  customers.set(RECIPIENT_ID, {
    id: RECIPIENT_ID,
    email: 'recipient@example.com',
    firstName: 'Recipient',
    lastName: 'Test',
    isBusiness: false,
    businessName: null,
    notificationPreferences: {},
    status: 'active',
  });
  // Seed tenant
  tenants.set(TENANT_ID, { id: TENANT_ID, businessName: 'Officina Test' });

  const tx = {
    user: {
      findFirstOrThrow: vi.fn().mockResolvedValue({ id: 'actor-db-id' }),
    },
    vehicle: {
      findFirst: vi.fn().mockImplementation(
        async ({
          where,
        }: {
          where: {
            id: string;
            OR?: Array<{ certifiedByTenantId?: string; createdByTenantId?: string }>;
          };
        }) => {
          for (const v of vehicles.values()) {
            if (v.id !== where.id) continue;
            if (where.OR) {
              const match = where.OR.some(
                (o) =>
                  (o.certifiedByTenantId !== undefined &&
                    v.certifiedByTenantId === o.certifiedByTenantId) ||
                  (o.createdByTenantId !== undefined &&
                    v.createdByTenantId === o.createdByTenantId),
              );
              if (!match) continue;
            }
            return v;
          }
          return null;
        },
      ),
    },
    vehicleOwnership: {
      findFirst: vi
        .fn()
        .mockImplementation(({ where }: { where: { vehicleId: string; endedAt: null } }) => {
          for (const o of ownerships.values()) {
            if (o.vehicleId === where.vehicleId && o.endedAt === null) return Promise.resolve(o);
          }
          return Promise.resolve(null);
        }),
      update: vi
        .fn()
        .mockImplementation(
          ({
            where,
            data,
          }: {
            where: { id: string };
            data: Partial<{ endedAt: Date; transferReason: string; transferNotes: string | null }>;
          }) => {
            const o = ownerships.get(where.id);
            if (o) Object.assign(o, data);
            return Promise.resolve(o);
          },
        ),
      create: vi.fn().mockImplementation(
        ({
          data,
        }: {
          data: {
            vehicleId: string;
            customerId: string;
            startedAt: Date;
            transferReason: string;
            transferNotes: string | null;
          };
        }) => {
          const id = `own-${ownerships.size + 1}`;
          ownerships.set(id, {
            id,
            vehicleId: data.vehicleId,
            customerId: data.customerId,
            endedAt: null,
          });
          return Promise.resolve({ id, customerId: data.customerId, startedAt: data.startedAt });
        },
      ),
    },
    vehicleTransfer: {
      findFirst: vi
        .fn()
        .mockImplementation(
          ({ where }: { where: { vehicleId: string; status: { in: string[] } } }) => {
            for (const t of transfers.values()) {
              if (t.vehicleId === where.vehicleId && where.status.in.includes(t.status)) {
                return Promise.resolve(t);
              }
            }
            return Promise.resolve(null);
          },
        ),
      create: vi
        .fn()
        .mockImplementation(
          ({ data }: { data: { vehicleId: string; status: string; completedAt: Date } }) => {
            const id = `tr-${transfers.size + 1}`;
            transfers.set(id, { id, vehicleId: data.vehicleId, status: data.status });
            return Promise.resolve({ id, completedAt: data.completedAt });
          },
        ),
    },
    customer: {
      findUnique: vi
        .fn()
        .mockImplementation(({ where }: { where: { id: string } }) =>
          Promise.resolve(customers.get(where.id) ?? null),
        ),
      findFirst: vi.fn().mockImplementation(({ where }: { where: { email: string } }) => {
        for (const c of customers.values()) {
          if (c.email === where.email) return Promise.resolve(c);
        }
        return Promise.resolve(null);
      }),
      create: vi.fn().mockImplementation(
        ({
          data,
        }: {
          data: {
            email: string;
            firstName: string;
            lastName: string;
            isBusiness?: boolean;
            businessName?: string | null;
          };
        }) => {
          const id = `c-${customers.size + 1}`;
          customers.set(id, {
            id,
            email: data.email,
            firstName: data.firstName,
            lastName: data.lastName,
            isBusiness: data.isBusiness ?? false,
            businessName: data.businessName ?? null,
            notificationPreferences: {},
            status: 'active',
          });
          return Promise.resolve({ id });
        },
      ),
    },
    customerTenantRelation: {
      upsert: vi
        .fn()
        .mockImplementation(
          ({
            where,
            create,
          }: {
            where: { tenantId_customerId: { tenantId: string; customerId: string } };
            update: Record<string, never>;
            create: { tenantId: string; customerId: string; interventionCount: number };
          }) => {
            const key = `${where.tenantId_customerId.tenantId}:${where.tenantId_customerId.customerId}`;
            if (!relations.has(key)) relations.set(key, create);
            return Promise.resolve({ id: key });
          },
        ),
    },
    accessLog: {
      create: vi
        .fn()
        .mockImplementation(
          ({
            data,
          }: {
            data: { vehicleId: string; tenantId: string; userId: string; action: string };
          }) => {
            accessLogs.push(data);
            return Promise.resolve(data);
          },
        ),
    },
    tenant: {
      findUniqueOrThrow: vi.fn().mockImplementation(({ where }: { where: { id: string } }) => {
        const t = tenants.get(where.id);
        if (!t) return Promise.reject(new Error('P2025'));
        return Promise.resolve(t);
      }),
    },
    // BR-297: performOwnershipTransfer cancels the previous owner's active
    // personal deadlines inside the same tx. No deadlines seeded here.
    personalDeadline: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    personalDeadlineReminder: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };

  // prisma mock for the outer app.prisma calls:
  //   - user.findFirst: used by tenantContext middleware to verify user is active
  //   - vehicle.findUniqueOrThrow: used by the route handler for the final read
  const prismaOuter = {
    user: {
      findFirst: vi.fn().mockResolvedValue({ id: 'actor-db-id' }),
    },
    vehicle: {
      findFirst: vi.fn().mockResolvedValue({ id: VEHICLE_ID }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        id: VEHICLE_ID,
        garageCode: null,
        plate: 'AB123CD',
        status: 'certified',
      }),
    },
  };

  return { tx, prismaOuter };
}

async function buildTransferApp(options: MakeTransferStubOptions = {}): Promise<FastifyInstance> {
  const { tx, prismaOuter } = makeTransferStub(options);
  const withContext = vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(tx));
  const appInstance = Fastify({ logger: false });
  await appInstance.register(sensible);
  registerErrorHandler(appInstance);
  await appInstance.register(databasePlugin, {
    prisma: prismaOuter as never,
    withContext: withContext as never,
  });
  appInstance.decorate('jwtVerifier', buildVerifier());
  await appInstance.register(vehiclesOwnershipTransferRoutes);
  await appInstance.ready();
  return appInstance;
}

describe('POST /v1/vehicles/:id/ownership-transfer — documentS3Key', () => {
  const TRANSFER_URL = `/v1/vehicles/${VEHICLE_ID}/ownership-transfer`;
  const validKey = `vehicle-transfers/${VEHICLE_ID}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.pdf`;
  const transferBody = {
    recipient: { kind: 'existing', customerId: RECIPIENT_ID },
    reason: 'purchase',
  };

  let transferApp: FastifyInstance;

  beforeEach(async () => {
    s3Mock.reset();
    _resetS3ClientForTests();
    transferApp = await buildTransferApp();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await transferApp.close();
  });

  it('rejects a documentS3Key that does not match the vehicle prefix with 422', async () => {
    // Key belongs to a different vehicle — regex should reject before any S3 call
    const headObjectSpy = vi.spyOn(s3Module, 'headObject');
    const wrongVehicleKey = `vehicle-transfers/00000000-0000-4000-8000-000000000000/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.pdf`;
    const res = await transferApp.inject({
      method: 'POST',
      url: TRANSFER_URL,
      headers: { authorization: 'Bearer fake-token' },
      payload: { ...transferBody, documentS3Key: wrongVehicleKey },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('vehicle.transfer.document_invalid');
    // headObject must NOT be called — regex rejects before the S3 call
    expect(headObjectSpy).not.toHaveBeenCalled();
  });

  it('rejects a documentS3Key whose S3 object does not exist with 422', async () => {
    vi.spyOn(s3Module, 'headObject').mockRejectedValueOnce(new S3ObjectNotFoundError('missing'));
    const res = await transferApp.inject({
      method: 'POST',
      url: TRANSFER_URL,
      headers: { authorization: 'Bearer fake-token' },
      payload: { ...transferBody, documentS3Key: validKey },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('vehicle.transfer.document_invalid');
  });

  it('maps headObject S3UnavailableError to 502 vehicle.transfer.document_s3_unavailable', async () => {
    vi.spyOn(s3Module, 'headObject').mockRejectedValueOnce(
      new s3Module.S3UnavailableError('S3 down'),
    );
    const res = await transferApp.inject({
      method: 'POST',
      url: TRANSFER_URL,
      headers: { authorization: 'Bearer fake-token' },
      payload: { ...transferBody, documentS3Key: validKey },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe('vehicle.transfer.document_s3_unavailable');
  });

  it('rejects a documentS3Key whose object exceeds 10 MB with 422', async () => {
    vi.spyOn(s3Module, 'headObject').mockResolvedValueOnce({
      contentLength: 10 * 1024 * 1024 + 1,
      contentType: 'application/pdf',
    });
    const res = await transferApp.inject({
      method: 'POST',
      url: TRANSFER_URL,
      headers: { authorization: 'Bearer fake-token' },
      payload: { ...transferBody, documentS3Key: validKey },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('vehicle.transfer.document_invalid');
  });

  it('accepts a valid documentS3Key and completes the transfer (200)', async () => {
    vi.spyOn(s3Module, 'headObject').mockResolvedValueOnce({
      contentLength: 1_048_576,
      contentType: 'application/pdf',
    });
    const res = await transferApp.inject({
      method: 'POST',
      url: TRANSFER_URL,
      headers: { authorization: 'Bearer fake-token' },
      payload: { ...transferBody, documentS3Key: validKey },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('POST /v1/vehicles/:id/ownership-transfer — cedente notification', () => {
  const TRANSFER_URL = `/v1/vehicles/${VEHICLE_ID}/ownership-transfer`;
  const transferBody = {
    recipient: { kind: 'existing', customerId: RECIPIENT_ID },
    reason: 'purchase',
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dispatches ownership.transferred event after successful transfer when cedente is active', async () => {
    const app2 = await buildTransferApp({ cedenteStatus: 'active' });
    const spy = vi
      .spyOn(dispatcherModule, 'dispatchNotification')
      .mockResolvedValue({ sent: true });

    const res = await app2.inject({
      method: 'POST',
      url: TRANSFER_URL,
      headers: { authorization: 'Bearer fake-token' },
      payload: transferBody,
    });

    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({ type: 'ownership.transferred' }),
      }),
    );

    spy.mockRestore();
    await app2.close();
  });

  it('skips dispatch when cedente is deleted (previousOwner is null)', async () => {
    const app2 = await buildTransferApp({ cedenteStatus: 'deleted' });
    const spy = vi
      .spyOn(dispatcherModule, 'dispatchNotification')
      .mockResolvedValue({ sent: false });

    const res = await app2.inject({
      method: 'POST',
      url: TRANSFER_URL,
      headers: { authorization: 'Bearer fake-token' },
      payload: transferBody,
    });

    expect(res.statusCode).toBe(200);
    expect(spy).not.toHaveBeenCalled();

    spy.mockRestore();
    await app2.close();
  });
});
