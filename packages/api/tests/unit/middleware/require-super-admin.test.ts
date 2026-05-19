import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, it, expect } from 'vitest';
import { requireSuperAdmin } from '../../../src/middleware/require-super-admin.js';
import { registerErrorHandler } from '../../../src/plugins/error-handler.js';
import type { UserRole } from '../../../src/middleware/tenant-context.js';

async function buildApp(role: UserRole | undefined): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  registerErrorHandler(app);
  app.get(
    '/admin-route',
    {
      preHandler: [
        async (request) => {
          // exactOptionalPropertyTypes: only assign when defined so the
          // undefined test case exercises the "property never set" path.
          if (role !== undefined) {
            request.userRole = role;
          }
        },
        requireSuperAdmin,
      ],
    },
    async (request) => ({ ok: true, role: request.userRole }),
  );
  return app;
}

describe('requireSuperAdmin middleware', () => {
  it('allows super_admin through', async () => {
    const app = await buildApp('super_admin');
    const res = await app.inject({ method: 'GET', url: '/admin-route' });
    expect(res.statusCode).toBe(200);
  });

  it('blocks mechanic with 403 + auth.forbidden.not_super_admin', async () => {
    const app = await buildApp('mechanic');
    const res = await app.inject({ method: 'GET', url: '/admin-route' });
    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.code).toBe('auth.forbidden.not_super_admin');
  });

  it('blocks request with missing userRole (chain misconfig) with 403', async () => {
    // No preHandler that sets userRole — simulates middleware chain misconfiguration
    const app = await buildApp(undefined);
    const res = await app.inject({ method: 'GET', url: '/admin-route' });
    expect(res.statusCode).toBe(403);
  });
});
