import { randomUUID } from 'node:crypto';
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

// Unique IP per rate-limit bucket isolation
// (lesson feedback_integration_test_rate_limit_isolation.md).
// 10.20.42.x is free across all existing integration test files.
const TEST_IP = '10.20.42.1';

function uniqueCode(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

// Inflate FlateDecode streams and decode <hex> Tj glyph runs back to Latin-1
// (same approach as vehicles-export-pdf.test.ts) so we can assert whether the
// officina name appears in the rendered document.
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

// Direct pgAdmin insert for a checklist item fixture — bypasses RLS
// (fixture setup only). Mirrors interventions-detail.test.ts.
async function seedChecklistItem(params: {
  interventionTypeId: string;
  nameIt?: string;
  sortOrder?: number;
}): Promise<{ id: string; nameIt: string }> {
  const { interventionTypeId, nameIt = `Test item ${uniqueCode('IITM')}`, sortOrder = 0 } = params;
  const code = uniqueCode('IITM');
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO intervention_checklist_items
       (id, intervention_type_id, code, name_it, sort_order, active, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, true, NOW(), NOW())
     RETURNING id`,
    [interventionTypeId, code, nameIt, sortOrder],
  );
  return { id: rows[0]!.id, nameIt };
}

async function seedChecklistSelection(params: {
  interventionId: string;
  tenantId: string;
  checklistItemId: string;
  labelSnapshot: string;
  sortOrderSnapshot?: number | null;
}): Promise<{ id: string }> {
  const {
    interventionId,
    tenantId,
    checklistItemId,
    labelSnapshot,
    sortOrderSnapshot = 0,
  } = params;
  const { rows } = await pgAdmin.query<{ id: string }>(
    `INSERT INTO intervention_checklist_selections
       (id, intervention_id, tenant_id, checklist_item_id, label_snapshot, sort_order_snapshot, created_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, NOW())
     RETURNING id`,
    [interventionId, tenantId, checklistItemId, labelSnapshot, sortOrderSnapshot],
  );
  return { id: rows[0]!.id };
}

// The single-intervention PDF renders via the SAME renderer as the bulk
// vehicle-history export (decided 2026-07-10), scoped to one intervention:
// neutral header, no officina letterhead / customer PII / operator. The
// `show_names` param toggles grouped (officina name printed) vs anonymous.
describe('GET /v1/interventions/:id/pdf (integration)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestServer();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb();
    // resetDb() truncates intervention_types as a CASCADE side-effect of
    // TRUNCATE tenants — re-seed so each test has a stable type FK.
    await ensureSystemInterventionType('MECCANICO');
    vi.clearAllMocks();
  });

  async function setupCaller(suffix: string) {
    const { tenantId } = await createTenantWithLocation(suffix);
    const cognitoSub = `pdf-caller-${suffix.slice(0, 18)}`;
    const { userId } = await createUser({ tenantId, cognitoSub });
    const token = await signTestToken({
      pool: 'officine',
      sub: cognitoSub,
      tenantId,
      role: 'mechanic',
    });
    return { tenantId, userId, token };
  }

  async function setupIntervention(args: {
    tenantId: string;
    userId: string;
    status?: 'active' | 'disputed' | 'cancelled';
  }) {
    const type = await ensureSystemInterventionType('MECCANICO');
    const { vehicleId } = await createVehicle({ createdByTenantId: args.tenantId });
    const { interventionId } = await createIntervention({
      tenantId: args.tenantId,
      userId: args.userId,
      vehicleId,
      interventionTypeId: type.id,
      interventionDate: '2026-05-20',
      odometerKm: 55000,
      description: 'Cambio olio e filtri',
      partsReplaced: [{ name: 'Olio motore', code: 'OIL-5W40', quantity: 5, notes: null }],
      status: args.status ?? 'active',
    });
    return { interventionId, vehicleId, typeId: type.id };
  }

  // -----------------------------------------------------------------------
  // Case 1 — 200 grouped (default): officina name printed + checklist label.
  // -----------------------------------------------------------------------
  it('200 — default (show_names=true): prints the officina name (grouped)', async () => {
    const { tenantId, userId, token } = await setupCaller('pdf-grouped');
    const { interventionId, typeId } = await setupIntervention({ tenantId, userId });
    const item = await seedChecklistItem({ interventionTypeId: typeId, sortOrder: 0 });
    await seedChecklistSelection({
      interventionId,
      tenantId,
      checklistItemId: item.id,
      labelSnapshot: item.nameIt,
      sortOrderSnapshot: 0,
    });
    const name = await businessNameOf(tenantId);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${interventionId}/pdf`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    const text = extractPdfText(res.rawPayload);
    expect(text).toContain(name);
    expect(text).toContain('1 intervento officina registrato');
    expect(text).toContain(item.nameIt);
  });

  // -----------------------------------------------------------------------
  // Case 2 — 200 anonymous: officina name absent.
  // -----------------------------------------------------------------------
  it('200 — show_names=false: omits the officina name (anonymous)', async () => {
    const { tenantId, userId, token } = await setupCaller('pdf-anon');
    const { interventionId } = await setupIntervention({ tenantId, userId });
    const name = await businessNameOf(tenantId);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${interventionId}/pdf?show_names=false`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(200);
    const text = extractPdfText(res.rawPayload);
    expect(text).not.toContain(name);
    expect(text).toMatch(/STORICO MANUTENZIONE VEICOLO/);
  });

  // -----------------------------------------------------------------------
  // Case 3 — 404 cross-tenant: intervention belongs to tenant A; caller is
  // tenant B. Route scopes findFirst {id, tenantId} → invisible → 404.
  // -----------------------------------------------------------------------
  it('404 — cross-tenant: intervention.not_found', async () => {
    const { tenantId: tenantA, userId: userA } = await setupCaller('pdf-xtA');
    const { interventionId } = await setupIntervention({ tenantId: tenantA, userId: userA });

    const { token: tokenB } = await setupCaller('pdf-xtB');

    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${interventionId}/pdf`,
      headers: { authorization: `Bearer ${tokenB}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('intervention.not_found');
  });

  // -----------------------------------------------------------------------
  // Case 4 — 200 cancelled intervention still exportable (no status filter).
  // -----------------------------------------------------------------------
  it('200 — cancelled intervention: PDF still exportable', async () => {
    const { tenantId, userId, token } = await setupCaller('pdf-cancel');
    const { interventionId } = await setupIntervention({ tenantId, userId, status: 'cancelled' });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/interventions/${interventionId}/pdf`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': TEST_IP },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
  });
});
