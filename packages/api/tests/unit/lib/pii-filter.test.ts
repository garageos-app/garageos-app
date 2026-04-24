import { describe, expect, it, vi } from 'vitest';

import { maskCustomer, resolvePiiVisibility } from '../../../src/lib/pii-filter.js';

// BR-151: a tenant can see a customer's PII only if a
// customer_tenant_relations row exists for (tenantId, customerId).
// resolvePiiVisibility takes a batch of customerIds and returns a Set
// of those the current tenant IS related to — the caller uses the Set
// to decide what to include in the response.

describe('resolvePiiVisibility', () => {
  const TENANT = '11111111-1111-4111-8111-111111111111';
  const CUST_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const CUST_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('returns empty Set when input is empty (no query issued)', async () => {
    const findMany = vi.fn();
    const result = await resolvePiiVisibility({
      tx: { customerTenantRelation: { findMany } } as never,
      tenantId: TENANT,
      customerIds: [],
    });
    expect(result.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('returns the subset of customerIds that the tenant is related to', async () => {
    const findMany = vi.fn().mockResolvedValue([{ customerId: CUST_A }]);
    const result = await resolvePiiVisibility({
      tx: { customerTenantRelation: { findMany } } as never,
      tenantId: TENANT,
      customerIds: [CUST_A, CUST_B],
    });
    expect(result).toEqual(new Set([CUST_A]));
    expect(findMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT, customerId: { in: [CUST_A, CUST_B] } },
      select: { customerId: true },
    });
  });

  it('deduplicates the customerIds passed to the DB', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await resolvePiiVisibility({
      tx: { customerTenantRelation: { findMany } } as never,
      tenantId: TENANT,
      customerIds: [CUST_A, CUST_A, CUST_B],
    });
    const call = findMany.mock.calls[0]?.[0] as {
      where: { customerId: { in: string[] } };
    };
    expect(call.where.customerId.in.sort()).toEqual([CUST_A, CUST_B].sort());
  });
});

describe('maskCustomer', () => {
  const fullCustomer = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    firstName: 'Mario',
    lastName: 'Rossi',
    email: 'mario@example.com',
    phone: '+39 333 1234567',
    isBusiness: false,
    businessName: null,
    vatNumber: null,
  };

  it('returns the full customer shape when visible=true', () => {
    const out = maskCustomer(fullCustomer, true);
    expect(out).toEqual({
      id: fullCustomer.id,
      firstName: 'Mario',
      lastName: 'Rossi',
      email: 'mario@example.com',
      phone: '+39 333 1234567',
      isBusiness: false,
      businessName: null,
      vatNumber: null,
      redacted: false,
    });
  });

  it('strips PII columns and sets redacted=true when visible=false', () => {
    const out = maskCustomer(fullCustomer, false);
    expect(out).toEqual({
      id: fullCustomer.id,
      redacted: true,
      displayName: 'Proprietario non in anagrafica',
    });
    expect(out).not.toHaveProperty('firstName');
    expect(out).not.toHaveProperty('email');
    expect(out).not.toHaveProperty('phone');
  });
});
