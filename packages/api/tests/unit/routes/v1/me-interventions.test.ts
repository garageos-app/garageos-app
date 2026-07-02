import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import type { JwtVerifier, VerifyResult } from '../../../../src/plugins/auth.js';
import meInterventionsRoutes from '../../../../src/routes/v1/me-interventions.js';

const COGNITO_SUB = '22222222-2222-4222-8222-222222222222';
const CUSTOMER_ID = '55555555-5555-4555-8555-555555555555';
const INTERVENTION_ID = '33333333-3333-4333-8333-333333333333';

interface FakePrisma {
  intervention: { findFirst: ReturnType<typeof vi.fn> };
  vehicleOwnership: { findFirst: ReturnType<typeof vi.fn> };
  interventionDispute: { findMany: ReturnType<typeof vi.fn> };
}

function buildFakePrisma(overrides: Partial<FakePrisma> = {}): FakePrisma {
  return {
    intervention: {
      findFirst: vi.fn().mockResolvedValue({
        id: INTERVENTION_ID,
        vehicleId: 'veh-1',
        interventionDate: new Date('2026-05-01T00:00:00.000Z'),
        odometerKm: 84210,
        title: 'Tagliando',
        description: 'desc',
        partsReplaced: [],
        status: 'active',
        interventionType: { code: 'MECCANICO', nameIt: 'Tagliando' },
        tenant: { businessName: 'Officina Rossi' },
        location: { city: 'Milano' },
        sourceDeadlines: [],
      }),
    },
    vehicleOwnership: { findFirst: vi.fn().mockResolvedValue({ id: 'own-1' }) },
    interventionDispute: { findMany: vi.fn().mockResolvedValue([]) },
    ...overrides,
  };
}

async function buildApp(prisma: FakePrisma): Promise<FastifyInstance> {
  const fakeWithContext = vi.fn(async (_ctx, fn) => fn(prisma));
  const verifier: JwtVerifier = {
    verify: async (): Promise<VerifyResult> => ({
      pool: 'clienti',
      payload: { sub: COGNITO_SUB, token_use: 'id', 'custom:customer_id': CUSTOMER_ID },
    }),
  };
  const app = Fastify({ logger: false });
  await app.register(sensible);
  registerErrorHandler(app);
  await app.register(databasePlugin, {
    prisma: prisma as never,
    withContext: fakeWithContext as never,
  });
  app.decorate('jwtVerifier', verifier);
  await app.register(meInterventionsRoutes);
  return app;
}

describe('GET /v1/me/interventions/:id (unit)', () => {
  it('returns intervention + disputes when the caller owns the vehicle', async () => {
    const app = await buildApp(buildFakePrisma());
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/interventions/${INTERVENTION_ID}`,
      headers: { authorization: 'Bearer x' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { intervention: { id: string }; disputes: unknown[] };
    expect(body.intervention.id).toBe(INTERVENTION_ID);
    expect(body.disputes).toEqual([]);
    await app.close();
  });

  it('returns the parts list and generated deadlines in the body', async () => {
    const prisma = buildFakePrisma({
      intervention: {
        findFirst: vi.fn().mockResolvedValue({
          id: INTERVENTION_ID,
          vehicleId: 'veh-1',
          interventionDate: new Date('2026-05-01T00:00:00.000Z'),
          odometerKm: 84210,
          title: 'Tagliando',
          description: 'desc',
          partsReplaced: [{ name: 'Olio', code: 'OIL-1', quantity: 1, notes: null }],
          status: 'active',
          interventionType: { code: 'MECCANICO', nameIt: 'Tagliando' },
          tenant: { businessName: 'Officina Rossi' },
          location: { city: 'Milano' },
          sourceDeadlines: [
            {
              id: 'dl-1',
              dueDate: new Date('2027-05-15T00:00:00.000Z'),
              dueOdometerKm: null,
              description: 'Prossima revisione',
              status: 'open',
              interventionType: { code: 'REVISIONE', nameIt: 'Revisione' },
            },
          ],
        }),
      },
    });
    const app = await buildApp(prisma);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/interventions/${INTERVENTION_ID}`,
      headers: { authorization: 'Bearer x' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      intervention: {
        partsReplaced: Array<{ name: string }>;
        partsReplacedCount: number;
        generatedDeadlines: Array<{ id: string; dueDate: string | null }>;
      };
    };
    expect(body.intervention.partsReplaced).toEqual([
      { name: 'Olio', code: 'OIL-1', quantity: 1, notes: null },
    ]);
    expect(body.intervention.partsReplacedCount).toBe(1);
    expect(body.intervention.generatedDeadlines).toHaveLength(1);
    expect(body.intervention.generatedDeadlines[0]!.dueDate).toBe('2027-05-15');
    await app.close();
  });

  it('returns 404 me.intervention.not_found when no active ownership', async () => {
    const prisma = buildFakePrisma({
      vehicleOwnership: { findFirst: vi.fn().mockResolvedValue(null) },
    });
    const app = await buildApp(prisma);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/interventions/${INTERVENTION_ID}`,
      headers: { authorization: 'Bearer x' },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('me.intervention.not_found');
    await app.close();
  });

  it('returns 404 when the intervention does not exist', async () => {
    const prisma = buildFakePrisma({
      intervention: { findFirst: vi.fn().mockResolvedValue(null) },
    });
    const app = await buildApp(prisma);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/me/interventions/${INTERVENTION_ID}`,
      headers: { authorization: 'Bearer x' },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('me.intervention.not_found');
    await app.close();
  });
});
