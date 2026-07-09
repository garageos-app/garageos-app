import { inflateSync } from 'node:zlib';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildTestServer } from './fixtures.js';
import {
  createIntervention,
  createTenantWithLocation,
  createUser,
  createVehicle,
  ensureSystemInterventionType,
  resetDb,
} from './helpers.js';
import { pgAdmin } from './setup.js';
import { signTestToken } from '../helpers/jwt.js';

// Inflate FlateDecode streams and decode <hex> Tj glyph runs back to Latin-1
// (same approach as vehicle-history-pdf-renderer.test.ts) so we can assert which
// officina names appear in the rendered document.
function extractPdfText(buf: Buffer): string {
  const hexPattern = /<([0-9A-Fa-f]+)>/g;
  let text = '';
  let pos = 0;
  const startMarker = Buffer.from('stream\n');
  const endMarker = Buffer.from('endstream');
  while (pos < buf.length) {
    const start = buf.indexOf(startMarker, pos);
    if (start === -1) break;
    const dataStart = start + startMarker.length;
    const dataEnd = buf.indexOf(endMarker, dataStart);
    if (dataEnd === -1) break;
    const chunk = buf.slice(dataStart, dataEnd);
    try {
      const inflated = inflateSync(chunk).toString('latin1');
      for (const m of inflated.matchAll(hexPattern)) {
        if (m[1]) text += Buffer.from(m[1], 'hex').toString('latin1');
      }
    } catch {
      // Non-deflate stream — skip.
    }
    pos = dataEnd + endMarker.length;
  }
  return text;
}

async function businessNameOf(tenantId: string): Promise<string> {
  const { rows } = await pgAdmin.query<{ business_name: string }>(
    'SELECT business_name FROM tenants WHERE id = $1',
    [tenantId],
  );
  return rows[0]!.business_name;
}

describe('GET /v1/vehicles/:id/export.pdf (integration)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestServer();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
    await ensureSystemInterventionType('MECCANICO');
    vi.clearAllMocks();
  });

  async function seedShopIntervention(args: {
    tenantId: string;
    userId: string;
    vehicleId: string;
    status?: 'active' | 'disputed' | 'cancelled';
    date?: string;
    description?: string;
  }) {
    const type = await ensureSystemInterventionType('MECCANICO');
    return createIntervention({
      tenantId: args.tenantId,
      userId: args.userId,
      vehicleId: args.vehicleId,
      interventionTypeId: type.id,
      interventionDate: args.date ?? '2026-05-20',
      odometerKm: 55000,
      description: args.description ?? 'Cambio olio e filtri',
      partsReplaced: [],
      status: args.status ?? 'active',
    });
  }

  it('scope=own excludes other tenants; scope=all includes them (BR-150)', async () => {
    const a = await createTenantWithLocation('off-pdf-A');
    const b = await createTenantWithLocation('off-pdf-B');
    const userA = await createUser({ tenantId: a.tenantId, cognitoSub: 'off-pdf-mechA' });
    const userB = await createUser({ tenantId: b.tenantId, cognitoSub: 'off-pdf-mechB' });
    const { vehicleId } = await createVehicle({ createdByTenantId: a.tenantId });
    await seedShopIntervention({
      tenantId: a.tenantId,
      userId: userA.userId,
      vehicleId,
      date: '2026-01-10',
    });
    await seedShopIntervention({
      tenantId: b.tenantId,
      userId: userB.userId,
      vehicleId,
      date: '2026-03-10',
    });

    const nameA = await businessNameOf(a.tenantId);
    const nameB = await businessNameOf(b.tenantId);
    const token = await signTestToken({
      pool: 'officine',
      sub: 'off-pdf-mechA',
      tenantId: a.tenantId,
      role: 'mechanic',
    });

    const own = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}/export.pdf?scope=own&show_names=true`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(own.statusCode).toBe(200);
    const ownText = extractPdfText(own.rawPayload);
    expect(ownText).toContain(nameA);
    expect(ownText).not.toContain(nameB);

    const all = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}/export.pdf?scope=all&show_names=true`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(all.statusCode).toBe(200);
    const allText = extractPdfText(all.rawPayload);
    expect(allText).toContain(nameA);
    expect(allText).toContain(nameB);
  });

  it('show_names=false omits officina names (anonymous flat list)', async () => {
    const a = await createTenantWithLocation('off-pdf-anon');
    const userA = await createUser({ tenantId: a.tenantId, cognitoSub: 'off-pdf-mech-anon' });
    const { vehicleId } = await createVehicle({ createdByTenantId: a.tenantId });
    await seedShopIntervention({ tenantId: a.tenantId, userId: userA.userId, vehicleId });

    const nameA = await businessNameOf(a.tenantId);
    const token = await signTestToken({
      pool: 'officine',
      sub: 'off-pdf-mech-anon',
      tenantId: a.tenantId,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}/export.pdf?scope=all&show_names=false`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const text = extractPdfText(res.rawPayload);
    expect(text).not.toContain(nameA);
    expect(text).toMatch(/STORICO MANUTENZIONE VEICOLO/);
  });

  it('excludes cancelled interventions (BR-150 active+disputed only)', async () => {
    const a = await createTenantWithLocation('off-pdf-canc');
    const userA = await createUser({ tenantId: a.tenantId, cognitoSub: 'off-pdf-mech-canc' });
    const { vehicleId } = await createVehicle({ createdByTenantId: a.tenantId });
    await seedShopIntervention({
      tenantId: a.tenantId,
      userId: userA.userId,
      vehicleId,
      description: 'Intervento attivo ABC',
    });
    await seedShopIntervention({
      tenantId: a.tenantId,
      userId: userA.userId,
      vehicleId,
      status: 'cancelled',
      description: 'Intervento annullato XYZ',
    });

    const token = await signTestToken({
      pool: 'officine',
      sub: 'off-pdf-mech-canc',
      tenantId: a.tenantId,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/vehicles/${vehicleId}/export.pdf?scope=all&show_names=true`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const text = extractPdfText(res.rawPayload);
    expect(text).toContain('Intervento attivo ABC');
    expect(text).not.toContain('Intervento annullato XYZ');
  });

  it('404 — vehicle.not_found for an unknown vehicle id', async () => {
    const a = await createTenantWithLocation('off-pdf-404');
    await createUser({ tenantId: a.tenantId, cognitoSub: 'off-pdf-mech-404' });
    const token = await signTestToken({
      pool: 'officine',
      sub: 'off-pdf-mech-404',
      tenantId: a.tenantId,
      role: 'mechanic',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/vehicles/55555555-5555-4555-8555-555555555555/export.pdf',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('vehicle.not_found');
  });
});
