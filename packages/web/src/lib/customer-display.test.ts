import { describe, expect, it } from 'vitest';

import { customerDisplayName } from './customer-display';

describe('customerDisplayName', () => {
  it('returns "Cognome Nome" for a private customer', () => {
    expect(
      customerDisplayName({
        isBusiness: false,
        businessName: null,
        firstName: 'Mario',
        lastName: 'Rossi',
      }),
    ).toBe('Rossi Mario');
  });

  it('returns the business name for a business customer', () => {
    expect(
      customerDisplayName({
        isBusiness: true,
        businessName: 'Trattoria Da Luigi S.r.l.',
        firstName: 'Luigi',
        lastName: 'Verdi',
      }),
    ).toBe('Trattoria Da Luigi S.r.l.');
  });

  it('falls back to person name when business has no businessName', () => {
    expect(
      customerDisplayName({
        isBusiness: true,
        businessName: null,
        firstName: 'Luigi',
        lastName: 'Verdi',
      }),
    ).toBe('Verdi Luigi');
  });
});
