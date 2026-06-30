import { describe, it, expect } from 'vitest';
import {
  encodeAuditCursor,
  decodeAuditCursor,
  serializeAuditLogItem,
} from '../../../src/lib/dtos/audit-log.js';

describe('audit cursor codec', () => {
  it('round-trips createdAt + id', () => {
    const row = {
      createdAt: new Date('2026-06-30T14:02:03.456Z'),
      id: 'a1b2c3d4-0000-0000-0000-000000000001',
    };
    const decoded = decodeAuditCursor(encodeAuditCursor(row));
    expect(decoded).toEqual({ createdAt: '2026-06-30T14:02:03.456Z', id: row.id });
  });
  it('returns null on garbage', () => {
    expect(decodeAuditCursor('not-base64!!!')).toBeNull();
    expect(decodeAuditCursor(Buffer.from('{"c":123}').toString('base64url'))).toBeNull(); // c not string
    expect(decodeAuditCursor(Buffer.from('{}').toString('base64url'))).toBeNull();
  });
});

describe('serializeAuditLogItem tenant resolution', () => {
  const base = {
    id: 'evt-1',
    createdAt: new Date('2026-06-30T00:00:00.000Z'),
    actorType: 'admin' as const,
    actorId: null,
    action: 'tenant_suspended',
    entityType: 'tenant',
    entityId: 'ten-1',
    ipAddress: null,
    metadata: { reason: 'x' },
  };
  it('null tenantId → platform event (tenant null)', () => {
    const out = serializeAuditLogItem({ ...base, tenantId: null }, new Map());
    expect(out.tenant).toBeNull();
  });
  it('known tenantId → name from map', () => {
    const out = serializeAuditLogItem(
      { ...base, tenantId: 'ten-1' },
      new Map([['ten-1', 'Officina Matula']]),
    );
    expect(out.tenant).toEqual({ id: 'ten-1', businessName: 'Officina Matula' });
  });
  it('unknown tenantId (hard-deleted) → businessName null', () => {
    const out = serializeAuditLogItem({ ...base, tenantId: 'gone' }, new Map());
    expect(out.tenant).toEqual({ id: 'gone', businessName: null });
  });
});
