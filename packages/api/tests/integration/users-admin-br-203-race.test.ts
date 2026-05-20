// Integration concurrent race test for BR-203 (last super_admin guard).
//
// Verifica che con SELECT FOR UPDATE, due DELETE concorrenti che
// targettano i due ultimi super_admin attivi non possano entrambe
// procedere — una vince (204), l'altra fallisce (409 user.last_super_admin).
// Senza FOR UPDATE, entrambe vedono remaining=1 e procedono → tenant orfano.

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './fixtures.js';
import { createTenantWithLocation, createUser, resetDb } from './helpers.js';
import { pgAdmin } from './setup.js';
import { signTestToken } from '../helpers/jwt.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestServer();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await resetDb();
});

describe('BR-203 — concurrent DELETE race', () => {
  const TEST_IP_A = '10.20.40.1';
  const TEST_IP_B = '10.20.40.2';

  it('two concurrent DELETEs on the last two super_admins → one 204, one 409', async () => {
    const { tenantId } = await createTenantWithLocation('br203-race');

    // Two super_admin: A and B. Each tries to delete the OTHER.
    const subA = `sa-race-a-${crypto.randomUUID()}`;
    const subB = `sa-race-b-${crypto.randomUUID()}`;
    const { userId: idA } = await createUser({
      tenantId,
      cognitoSub: subA,
      email: 'race-a@test.it',
      role: 'super_admin',
    });
    const { userId: idB } = await createUser({
      tenantId,
      cognitoSub: subB,
      email: 'race-b@test.it',
      role: 'super_admin',
    });

    const tokenA = await signTestToken({
      pool: 'officine',
      sub: subA,
      tenantId,
      role: 'super_admin',
    });
    const tokenB = await signTestToken({
      pool: 'officine',
      sub: subB,
      tenantId,
      role: 'super_admin',
    });

    // A tries to DELETE B; B tries to DELETE A. Fire concurrently.
    const [resA, resB] = await Promise.all([
      app.inject({
        method: 'DELETE',
        url: `/v1/users/${idB}`,
        headers: { authorization: `Bearer ${tokenA}` },
        remoteAddress: TEST_IP_A,
      }),
      app.inject({
        method: 'DELETE',
        url: `/v1/users/${idA}`,
        headers: { authorization: `Bearer ${tokenB}` },
        remoteAddress: TEST_IP_B,
      }),
    ]);

    const codes = [resA.statusCode, resB.statusCode].sort((x, y) => x - y);
    expect(codes).toEqual([204, 409]);

    // Identify the 409 response and assert correct error code.
    const failedRes = resA.statusCode === 409 ? resA : resB;
    expect(failedRes.json().code).toBe('user.last_super_admin');

    // DB invariant: at least 1 super_admin active remains.
    const { rows } = await pgAdmin.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM users
        WHERE tenant_id = $1
          AND role = 'super_admin'
          AND status = 'active'
          AND deleted_at IS NULL`,
      [tenantId],
    );
    expect(parseInt(rows[0]!.count, 10)).toBeGreaterThanOrEqual(1);
  });

  it('three super_admin: two concurrent DELETEs both succeed (one super_admin left)', async () => {
    const { tenantId } = await createTenantWithLocation('br203-3super');

    const subA = `sa-3a-${crypto.randomUUID()}`;
    const subB = `sa-3b-${crypto.randomUUID()}`;
    const subC = `sa-3c-${crypto.randomUUID()}`;
    const { userId: idA } = await createUser({
      tenantId,
      cognitoSub: subA,
      email: '3a@test.it',
      role: 'super_admin',
    });
    const { userId: idB } = await createUser({
      tenantId,
      cognitoSub: subB,
      email: '3b@test.it',
      role: 'super_admin',
    });
    await createUser({
      tenantId,
      cognitoSub: subC,
      email: '3c@test.it',
      role: 'super_admin',
    });

    // C is the actor for both calls — delete A, then delete B, concurrently.
    const tokenC = await signTestToken({
      pool: 'officine',
      sub: subC,
      tenantId,
      role: 'super_admin',
    });

    const [resDeleteA, resDeleteB] = await Promise.all([
      app.inject({
        method: 'DELETE',
        url: `/v1/users/${idA}`,
        headers: { authorization: `Bearer ${tokenC}` },
        remoteAddress: '10.20.40.10',
      }),
      app.inject({
        method: 'DELETE',
        url: `/v1/users/${idB}`,
        headers: { authorization: `Bearer ${tokenC}` },
        remoteAddress: '10.20.40.11',
      }),
    ]);

    expect(resDeleteA.statusCode).toBe(204);
    expect(resDeleteB.statusCode).toBe(204);

    const { rows } = await pgAdmin.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM users
        WHERE tenant_id = $1
          AND role = 'super_admin'
          AND status = 'active'
          AND deleted_at IS NULL`,
      [tenantId],
    );
    expect(parseInt(rows[0]!.count, 10)).toBe(1);
  });
});
