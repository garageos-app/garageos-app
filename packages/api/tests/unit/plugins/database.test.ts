import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import databasePlugin from '../../../src/plugins/database.js';

// Unit tests inject a fake Prisma client via plugin options so no
// database connection is opened. Integration tests (tests/integration)
// exercise the default path against a real Testcontainers instance.

describe('databasePlugin', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = Fastify({ logger: false });
  });

  afterEach(async () => {
    await app.close();
  });

  it('decorates the instance with prisma and withContext', async () => {
    const fakePrisma = { $disconnect: vi.fn().mockResolvedValue(undefined) };
    const fakeWithContext = vi.fn();

    await app.register(databasePlugin, {
      prisma: fakePrisma as never,
      withContext: fakeWithContext as never,
    });

    expect(app.prisma).toBe(fakePrisma);
    expect(app.withContext).toBe(fakeWithContext);
  });

  it('decorator is readable from a route handler (fp wrapper propagates)', async () => {
    const fakePrisma = { $disconnect: vi.fn().mockResolvedValue(undefined) };
    await app.register(databasePlugin, {
      prisma: fakePrisma as never,
      withContext: (() => undefined) as never,
    });
    app.get('/_probe', async (req) => ({
      hasPrisma: (req.server.prisma as unknown) === fakePrisma,
    }));

    const res = await app.inject({ method: 'GET', url: '/_probe' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ hasPrisma: true });
  });

  it('calls prisma.$disconnect on app.close outside test env', async () => {
    const fakePrisma = { $disconnect: vi.fn().mockResolvedValue(undefined) };
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';

    try {
      await app.register(databasePlugin, {
        prisma: fakePrisma as never,
        withContext: (() => undefined) as never,
      });
      await app.close();
      expect(fakePrisma.$disconnect).toHaveBeenCalledTimes(1);
    } finally {
      process.env.NODE_ENV = prevEnv;
      // buildFastify → afterEach close is a no-op on an already-closed
      // app, but reassign so the shared afterEach does not reopen it.
      app = Fastify({ logger: false });
    }
  });

  it('does NOT call prisma.$disconnect on app.close when NODE_ENV=test', async () => {
    const fakePrisma = { $disconnect: vi.fn().mockResolvedValue(undefined) };
    // NODE_ENV is forced to 'test' by tests/unit/setup.ts.
    expect(process.env.NODE_ENV).toBe('test');

    await app.register(databasePlugin, {
      prisma: fakePrisma as never,
      withContext: (() => undefined) as never,
    });
    await app.close();

    // The Prisma singleton is shared across integration-test files via
    // globalThis caching; disconnecting between files would break the
    // second file's queries. See packages/database/tests/integration/setup.ts:85.
    expect(fakePrisma.$disconnect).not.toHaveBeenCalled();
    app = Fastify({ logger: false });
  });
});
