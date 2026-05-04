import { describe, expect, it } from 'vitest';

import { customerSelfSelect, projectCustomerSelf } from '../../../src/lib/customer-shared.js';

describe('customer-shared', () => {
  describe('customerSelfSelect', () => {
    it('exposes only fields the signup response returns', () => {
      expect(customerSelfSelect).toEqual({
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        status: true,
        createdAt: true,
      });
    });
  });

  describe('projectCustomerSelf', () => {
    it('returns the row verbatim with phone preserved when populated', () => {
      const row = {
        id: 'cust-1',
        email: 'a@b.it',
        firstName: 'Mario',
        lastName: 'Rossi',
        phone: '+393331234567',
        status: 'active' as const,
        createdAt: new Date('2026-05-04T10:00:00Z'),
      };
      expect(projectCustomerSelf(row)).toEqual({
        id: 'cust-1',
        email: 'a@b.it',
        firstName: 'Mario',
        lastName: 'Rossi',
        phone: '+393331234567',
        status: 'active',
        createdAt: '2026-05-04T10:00:00.000Z',
      });
    });

    it('returns phone=null when row.phone is null', () => {
      const row = {
        id: 'cust-2',
        email: 'a@b.it',
        firstName: 'Mario',
        lastName: 'Rossi',
        phone: null,
        status: 'active' as const,
        createdAt: new Date('2026-05-04T10:00:00Z'),
      };
      expect(projectCustomerSelf(row).phone).toBeNull();
    });
  });
});
