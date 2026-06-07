import { describe, expect, it } from 'vitest';

import {
  projectCustomerListRow,
  type CustomerListRow,
} from '../../../src/lib/customer-list-shared.js';

function row(overrides: Partial<CustomerListRow> = {}): CustomerListRow {
  return {
    id: 'cust-1',
    firstName: 'Mario',
    lastName: 'Rossi',
    phone: '+39 333 1234567',
    isBusiness: false,
    businessName: null,
    _count: { ownerships: 2 },
    tenantRelations: [{ lastInterventionAt: new Date('2026-05-01T10:00:00.000Z') }],
    ...overrides,
  };
}

describe('projectCustomerListRow', () => {
  it('maps fields and serializes lastInterventionAt to ISO', () => {
    expect(projectCustomerListRow(row())).toEqual({
      id: 'cust-1',
      firstName: 'Mario',
      lastName: 'Rossi',
      phone: '+39 333 1234567',
      isBusiness: false,
      businessName: null,
      vehicleCount: 2,
      lastInterventionAt: '2026-05-01T10:00:00.000Z',
    });
  });

  it('returns lastInterventionAt null when the CTR has none', () => {
    const dto = projectCustomerListRow(row({ tenantRelations: [{ lastInterventionAt: null }] }));
    expect(dto.lastInterventionAt).toBeNull();
  });

  it('passes phone null through and reads vehicleCount from _count', () => {
    const dto = projectCustomerListRow(row({ phone: null, _count: { ownerships: 0 } }));
    expect(dto.phone).toBeNull();
    expect(dto.vehicleCount).toBe(0);
  });
});
