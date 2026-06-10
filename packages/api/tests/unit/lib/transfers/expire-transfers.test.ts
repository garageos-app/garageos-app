import { describe, expect, it, vi } from 'vitest';

import type { PrismaClient } from '@garageos/database';

import type { AppLike } from '../../../../src/lib/transfers/expire-transfers.js';
import { processTransferExpiry } from '../../../../src/lib/transfers/expire-transfers.js';

interface FakePrisma {
  vehicleTransfer: { updateMany: ReturnType<typeof vi.fn> };
}

function asPrisma(fake: FakePrisma): PrismaClient {
  return fake as unknown as PrismaClient;
}

function makeFakeApp(fake: FakePrisma): AppLike & { _ctx: { ctx?: unknown } } {
  const captured: { ctx?: unknown } = {};
  return {
    _ctx: captured,
    withContext: vi
      .fn()
      .mockImplementation(async (ctx: unknown, fn: (tx: PrismaClient) => Promise<unknown>) => {
        captured.ctx = ctx;
        return fn(asPrisma(fake));
      }),
    log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as unknown as AppLike['log'],
  } as AppLike & { _ctx: { ctx?: unknown } };
}

describe('processTransferExpiry', () => {
  it('sweeps pending_recipient/pending_seller_confirmation past expiresAt to expired under role admin', async () => {
    const fake: FakePrisma = {
      vehicleTransfer: { updateMany: vi.fn().mockResolvedValue({ count: 3 }) },
    };
    const app = makeFakeApp(fake);

    const result = await processTransferExpiry({ app });

    expect(result).toEqual({ sweptCount: 3 });
    expect(app._ctx.ctx).toEqual({ role: 'admin' });

    const arg = fake.vehicleTransfer.updateMany.mock.calls[0]![0];
    expect(arg.where.status).toEqual({ in: ['pending_recipient', 'pending_seller_confirmation'] });
    expect(arg.where.expiresAt).toHaveProperty('lt');
    expect(arg.where.expiresAt.lt).toBeInstanceOf(Date);
    expect(arg.where.status.in).not.toContain('pending_validation');
    expect(arg.data).toEqual({ status: 'expired' });
  });

  it('returns sweptCount 0 when nothing is expired (idempotent re-run)', async () => {
    const fake: FakePrisma = {
      vehicleTransfer: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };
    const result = await processTransferExpiry({ app: makeFakeApp(fake) });
    expect(result).toEqual({ sweptCount: 0 });
  });

  it('logs the swept count', async () => {
    const fake: FakePrisma = {
      vehicleTransfer: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
    };
    const app = makeFakeApp(fake);
    await processTransferExpiry({ app });
    expect(app.log.info).toHaveBeenCalledWith({ transferExpiry: { sweptCount: 2 } });
  });

  it('propagates a database error (so EventBridge retries)', async () => {
    const boom = new Error('db down');
    const fake: FakePrisma = {
      vehicleTransfer: { updateMany: vi.fn().mockRejectedValue(boom) },
    };
    await expect(processTransferExpiry({ app: makeFakeApp(fake) })).rejects.toBe(boom);
  });
});
