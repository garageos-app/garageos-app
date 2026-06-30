import { describe, expect, it } from 'vitest';

import { serializeCustomerAccessLog } from '../../../src/lib/customer-access-log.js';

const TENANT_REL = '55555555-5555-4555-8555-555555555555';
const TENANT_NO_REL = '66666666-6666-4666-8666-666666666666';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    action: 'view',
    createdAt: new Date('2026-06-04T10:00:00.000Z'),
    tenant: { id: TENANT_REL, businessName: 'Officina Rossi' },
    user: { firstName: 'Mario', lastName: 'Bianchi' },
    ...overrides,
  };
}

describe('serializeCustomerAccessLog', () => {
  it('maps view -> view and create -> new_intervention', () => {
    const out = serializeCustomerAccessLog(
      [row({ action: 'view' }), row({ action: 'create' })],
      new Set<string>(),
    );
    expect(out[0]!.action).toBe('view');
    expect(out[1]!.action).toBe('new_intervention');
  });

  it('emits the redacted BR-155 shape and no internal fields', () => {
    const [entry] = serializeCustomerAccessLog([row()], new Set([TENANT_REL]));
    expect(entry).toEqual({
      action: 'view',
      tenantName: 'Officina Rossi',
      occurredAt: '2026-06-04T10:00:00.000Z',
      mechanicName: 'Mario Bianchi',
    });
    // No internal ids / ip / user agent leaked.
    expect(entry).not.toHaveProperty('id');
    expect(entry).not.toHaveProperty('tenantId');
    expect(entry).not.toHaveProperty('userId');
    expect(entry).not.toHaveProperty('locationId');
    expect(entry).not.toHaveProperty('locationCity');
    expect(entry).not.toHaveProperty('vehicleId');
    expect(entry).not.toHaveProperty('ipAddress');
    expect(entry).not.toHaveProperty('userAgent');
  });

  it('omits mechanicName when no customer_tenant_relation exists', () => {
    const [entry] = serializeCustomerAccessLog(
      [row({ tenant: { id: TENANT_NO_REL, businessName: 'Officina Verdi' } })],
      new Set([TENANT_REL]),
    );
    expect(entry).not.toHaveProperty('mechanicName');
    expect(entry!.tenantName).toBe('Officina Verdi');
  });
});
