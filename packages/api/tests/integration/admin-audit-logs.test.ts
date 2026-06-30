// Integration tests for GET /v1/admin/audit-logs — global audit viewer.
//
// Tier-1:
//   1. Pool isolation — officine 403, clienti 403, no-auth 401.
//   2. Cross-tenant read + tenant-name resolution.
//   3. Deleted-tenant name fallback (tenantId has no matching row).
//   4. Filter — tenantId UUID and 'platform'.
//   5. Filter — action and actorType.
//   6. Filter — date range (boundary inclusivity: row exactly at `from` included).
//   7. Keyset pagination — no gap / no overlap over 5 rows with limit=2.
//   8. Invalid params → 400 VALIDATION_ERROR (RFC7807 envelope).
//   9. Same-timestamp keyset regression — 3 rows sharing an identical µs
//      createdAt are all returned across pages (no boundary gap). Guards the
//      full-precision keyset fix (microsecond cursor + row-value comparison).
//  10. Inverted range (from > to) → 400 VALIDATION_ERROR.
//
// CI-only (Docker / Testcontainers). Do NOT run locally on Windows —
// Testcontainers freezes the machine (feedback_skip_local_integration_tests.md).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { PROBLEM_JSON_CONTENT_TYPE } from '../../src/config/constants.js';
import type { AuditLogPage } from '../../src/lib/dtos/audit-log.js';

import { buildTestServer } from './fixtures.js';
import { resetDb, createTenant, createAuditLog } from './helpers.js';
import { signTestToken } from '../helpers/jwt.js';

// ─── Pool isolation ───────────────────────────────────────────────────────────

describe('GET /v1/admin/audit-logs — pool isolation (integration)', () => {
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

  it('returns 401 when no Authorization header is present', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/admin/audit-logs' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/UNAUTHORIZED',
      status: 401,
    });
  });

  it('returns 403 FORBIDDEN for an officine token', async () => {
    const token = await signTestToken({ pool: 'officine' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/audit-logs',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/FORBIDDEN',
      status: 403,
    });
  });

  it('returns 403 FORBIDDEN for a clienti token', async () => {
    const token = await signTestToken({ pool: 'clienti' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/audit-logs',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/FORBIDDEN',
      status: 403,
    });
  });
});

// ─── Core behaviour ───────────────────────────────────────────────────────────

describe('GET /v1/admin/audit-logs — core behaviour (integration)', () => {
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

  // Case 2: cross-tenant read + tenant-name resolution.
  it('returns rows from multiple tenants and resolves tenant names correctly', async () => {
    const { tenantId: tenantA } = await createTenant('audit-A');
    const { tenantId: tenantB } = await createTenant('audit-B');

    const { id: rowA } = await createAuditLog({ tenantId: tenantA, action: 'tenant_updated' });
    const { id: rowB } = await createAuditLog({ tenantId: tenantB, action: 'tenant_suspended' });
    const { id: rowPlatform } = await createAuditLog({ tenantId: null, action: 'admin_login' });

    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/audit-logs',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as AuditLogPage;
    expect(body.items).toHaveLength(3);

    const ids = body.items.map((i) => i.id);
    expect(ids).toContain(rowA);
    expect(ids).toContain(rowB);
    expect(ids).toContain(rowPlatform);

    // Tenant A's row should include the resolved business name.
    const itemA = body.items.find((i) => i.id === rowA)!;
    expect(itemA.tenant).not.toBeNull();
    expect(itemA.tenant!.businessName).toBe('Test Tenant audit-A');

    // Platform-level row (tenantId = null) → tenant field must be null.
    const itemPlatform = body.items.find((i) => i.id === rowPlatform)!;
    expect(itemPlatform.tenant).toBeNull();
  });

  // Case 3: deleted-tenant name fallback.
  // audit_logs has no FK on tenant_id; a row can reference a UUID that
  // has no matching tenant row. The serializer must return businessName: null
  // without crashing or dropping the row.
  it('returns tenant: { businessName: null } for a row whose tenantId has no matching tenant', async () => {
    // Use a UUID that was never inserted into the tenants table.
    const ghostTenantId = crypto.randomUUID();
    const { id: rowGhost } = await createAuditLog({
      tenantId: ghostTenantId,
      action: 'orphan_event',
    });

    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/audit-logs',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as AuditLogPage;
    const itemGhost = body.items.find((i) => i.id === rowGhost);
    expect(itemGhost).toBeDefined();
    // The row must appear with businessName: null — not a 500, not omitted.
    expect(itemGhost!.tenant).toMatchObject({ id: ghostTenantId, businessName: null });
  });

  // Case 4a: filter by tenantId UUID.
  it("filters by tenantId UUID — returns only that tenant's rows", async () => {
    const { tenantId: tenantA } = await createTenant('filter-A');
    const { tenantId: tenantB } = await createTenant('filter-B');

    const { id: rowA } = await createAuditLog({ tenantId: tenantA, action: 'ev' });
    await createAuditLog({ tenantId: tenantB, action: 'ev' });
    await createAuditLog({ tenantId: null, action: 'ev' });

    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/audit-logs?tenantId=${tenantA}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as AuditLogPage;
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.id).toBe(rowA);
  });

  // Case 4b: filter by tenantId=platform.
  it('filters by tenantId=platform — returns only null-tenantId rows', async () => {
    const { tenantId } = await createTenant('filter-platform');

    await createAuditLog({ tenantId, action: 'tenant_ev' });
    const { id: rowPlatform } = await createAuditLog({ tenantId: null, action: 'platform_ev' });

    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/audit-logs?tenantId=platform',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as AuditLogPage;
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.id).toBe(rowPlatform);
  });

  // Case 5a: filter by action.
  it('filters by action — returns only rows with matching action', async () => {
    const { id: match } = await createAuditLog({ action: 'tenant_suspended', actorType: 'admin' });
    await createAuditLog({ action: 'tenant_updated', actorType: 'admin' });

    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/audit-logs?action=tenant_suspended',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as AuditLogPage;
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.id).toBe(match);
  });

  // Case 5b: filter by actorType.
  it('filters by actorType — returns only rows with matching actorType', async () => {
    const { id: matchCustomer } = await createAuditLog({
      action: 'profile_updated',
      actorType: 'customer',
    });
    await createAuditLog({ action: 'tenant_suspended', actorType: 'admin' });

    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/audit-logs?actorType=customer',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as AuditLogPage;
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.id).toBe(matchCustomer);
  });

  // Case 6: date range filter with boundary inclusivity.
  it('filters by date range and includes the row exactly at the from boundary', async () => {
    const from = new Date('2024-01-15T10:00:00.000Z');
    const to = new Date('2024-01-15T12:00:00.000Z');

    const { id: beforeId } = await createAuditLog({
      action: 'before',
      createdAt: new Date('2024-01-15T09:59:59.000Z'),
    });
    // Exactly at `from` boundary — must be INCLUDED (createdAt >= from).
    const { id: boundaryId } = await createAuditLog({
      action: 'at_boundary',
      createdAt: new Date('2024-01-15T10:00:00.000Z'),
    });
    const { id: insideId } = await createAuditLog({
      action: 'inside',
      createdAt: new Date('2024-01-15T11:00:00.000Z'),
    });
    const { id: afterId } = await createAuditLog({
      action: 'after',
      createdAt: new Date('2024-01-15T12:00:01.000Z'),
    });

    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/audit-logs?from=${from.toISOString()}&to=${to.toISOString()}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as AuditLogPage;
    const ids = body.items.map((i) => i.id);

    expect(ids).toContain(boundaryId); // boundary row included (>= from)
    expect(ids).toContain(insideId);
    expect(ids).not.toContain(beforeId);
    expect(ids).not.toContain(afterId);
    expect(body.items).toHaveLength(2);
  });

  // Case 7: keyset pagination — 5 rows, limit=2, 3 pages, no gap/no overlap.
  it('paginates over 5 rows with limit=2 using keyset cursor — no gap, no overlap', async () => {
    // Seed 5 rows with distinct timestamps spread across 5 hours (newest last).
    const t1 = new Date('2024-06-01T05:00:00.000Z'); // oldest
    const t2 = new Date('2024-06-01T06:00:00.000Z');
    const t3 = new Date('2024-06-01T07:00:00.000Z');
    const t4 = new Date('2024-06-01T08:00:00.000Z');
    const t5 = new Date('2024-06-01T09:00:00.000Z'); // newest

    const { id: id1 } = await createAuditLog({ action: 'page_ev', createdAt: t1 });
    const { id: id2 } = await createAuditLog({ action: 'page_ev', createdAt: t2 });
    const { id: id3 } = await createAuditLog({ action: 'page_ev', createdAt: t3 });
    const { id: id4 } = await createAuditLog({ action: 'page_ev', createdAt: t4 });
    const { id: id5 } = await createAuditLog({ action: 'page_ev', createdAt: t5 });

    const token = await signTestToken({ pool: 'platform-admins' });

    // Page 1: newest-first → id5, id4.
    const res1 = await app.inject({
      method: 'GET',
      url: '/v1/admin/audit-logs?limit=2&action=page_ev',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res1.statusCode).toBe(200);
    const page1 = res1.json() as AuditLogPage;
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    expect(page1.items[0]!.id).toBe(id5);
    expect(page1.items[1]!.id).toBe(id4);

    // Page 2: continues from cursor → id3, id2.
    const res2 = await app.inject({
      method: 'GET',
      url: `/v1/admin/audit-logs?limit=2&action=page_ev&cursor=${page1.nextCursor!}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res2.statusCode).toBe(200);
    const page2 = res2.json() as AuditLogPage;
    expect(page2.items).toHaveLength(2);
    expect(page2.nextCursor).not.toBeNull();
    expect(page2.items[0]!.id).toBe(id3);
    expect(page2.items[1]!.id).toBe(id2);

    // Page 3 (final): → id1, nextCursor must be null.
    const res3 = await app.inject({
      method: 'GET',
      url: `/v1/admin/audit-logs?limit=2&action=page_ev&cursor=${page2.nextCursor!}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res3.statusCode).toBe(200);
    const page3 = res3.json() as AuditLogPage;
    expect(page3.items).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();
    expect(page3.items[0]!.id).toBe(id1);

    // Verify no gap / no overlap across all three pages.
    const allIds = [
      ...page1.items.map((i) => i.id),
      ...page2.items.map((i) => i.id),
      ...page3.items.map((i) => i.id),
    ];
    expect(allIds).toHaveLength(5);
    expect(new Set(allIds).size).toBe(5); // no duplicates
    for (const expected of [id1, id2, id3, id4, id5]) {
      expect(allIds).toContain(expected);
    }
  });

  // Case 9: same-timestamp keyset regression (full-precision cursor).
  // Three rows share an IDENTICAL createdAt (as rows written in one tx do).
  // With limit=2 the same-timestamp group straddles a page boundary; the
  // microsecond cursor + (created_at, id) row-value comparison must return all
  // three with no duplicate and no omission. A ms-truncated cursor would skip
  // the boundary row.
  it('returns all rows sharing an identical createdAt across page boundaries', async () => {
    const sharedTs = new Date('2026-06-30T10:00:00.000Z');
    const { id: a } = await createAuditLog({ action: 'tie_ev', createdAt: sharedTs });
    const { id: b } = await createAuditLog({ action: 'tie_ev', createdAt: sharedTs });
    const { id: c } = await createAuditLog({ action: 'tie_ev', createdAt: sharedTs });

    const token = await signTestToken({ pool: 'platform-admins' });

    const res1 = await app.inject({
      method: 'GET',
      url: '/v1/admin/audit-logs?limit=2&action=tie_ev',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res1.statusCode).toBe(200);
    const page1 = res1.json() as AuditLogPage;
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    const res2 = await app.inject({
      method: 'GET',
      url: `/v1/admin/audit-logs?limit=2&action=tie_ev&cursor=${page1.nextCursor!}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res2.statusCode).toBe(200);
    const page2 = res2.json() as AuditLogPage;
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();

    const allIds = [...page1.items.map((i) => i.id), ...page2.items.map((i) => i.id)];
    expect(allIds).toHaveLength(3);
    expect(new Set(allIds).size).toBe(3); // no duplicate
    for (const expected of [a, b, c]) {
      expect(allIds).toContain(expected); // no omission
    }
  });

  // Case 10: inverted date range (from > to) → 400 VALIDATION_ERROR.
  it('returns 400 VALIDATION_ERROR when from > to', async () => {
    const token = await signTestToken({ pool: 'platform-admins' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/audit-logs?from=2026-06-30T00:00:00.000Z&to=2026-06-01T00:00:00.000Z',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
    expect(res.json()).toMatchObject({
      type: 'https://api.garageos.it/errors/VALIDATION_ERROR',
      status: 400,
    });
  });

  // Case 8: invalid query parameters → 400 VALIDATION_ERROR (RFC7807).
  it('returns 400 VALIDATION_ERROR for invalid query params', async () => {
    const token = await signTestToken({ pool: 'platform-admins' });
    const cases = [
      { url: '/v1/admin/audit-logs?limit=0', desc: 'limit below minimum' },
      { url: '/v1/admin/audit-logs?actorType=bogus', desc: 'unknown actorType value' },
      { url: '/v1/admin/audit-logs?tenantId=not-a-uuid', desc: 'tenantId not uuid or platform' },
      { url: '/v1/admin/audit-logs?cursor=garbage!!!', desc: 'malformed cursor token' },
    ];

    for (const { url } of cases) {
      const res = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(400);
      expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
      expect(res.json()).toMatchObject({
        type: 'https://api.garageos.it/errors/VALIDATION_ERROR',
        status: 400,
      });
    }
  });
});
