import { describe, expect, it } from 'vitest';

import { formToPatch } from './customer-form';
import type { CustomerDetailDto, FormValues } from './customer-form';

// Minimal DTO fixture — only the fields formToPatch reads.
function makeDto(overrides: Partial<CustomerDetailDto> = {}): CustomerDetailDto {
  return {
    id: 'cust-uuid',
    email: 'mario@example.it',
    firstName: 'Mario',
    lastName: 'Rossi',
    isBusiness: false,
    phone: null,
    taxCode: null,
    businessName: null,
    vatNumber: null,
    addressLine: null,
    city: null,
    province: null,
    postalCode: null,
    cognitoSub: null,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    tenantRelation: {
      tenantNotes: null,
      interventionCount: 0,
      firstInterventionAt: null,
      lastInterventionAt: null,
    },
    vehicles: [],
    ...overrides,
  };
}

function makeValues(overrides: Partial<FormValues> = {}): FormValues {
  return {
    firstName: 'Mario',
    lastName: 'Rossi',
    isBusiness: false,
    phone: '',
    taxCode: '',
    businessName: '',
    vatNumber: '',
    addressLine: '',
    city: '',
    province: '',
    postalCode: '',
    tenantNotes: '',
    ...overrides,
  };
}

describe('formToPatch', () => {
  it('returns empty patch when nothing changed', () => {
    const dto = makeDto();
    const values = makeValues();
    expect(formToPatch(values, dto)).toEqual({});
  });

  it('includes only changed top-level fields', () => {
    const dto = makeDto({ firstName: 'Mario' });
    const values = makeValues({ firstName: 'Luigi' });
    expect(formToPatch(values, dto)).toEqual({ firstName: 'Luigi' });
  });

  it('treats empty-string nullable as null', () => {
    const dto = makeDto({ phone: '+391234567' });
    const values = makeValues({ phone: '' });
    expect(formToPatch(values, dto)).toEqual({ phone: null });
  });

  // EDGE CASE: voce 10 — when isBusiness toggles true→false and the watch
  // effect (voce 11) clears businessName + vatNumber, the resulting patch
  // must include isBusiness:false AND businessName:null + vatNumber:null
  // because the DTO previously had business values.
  it('includes businessName/vatNumber as null when isBusiness toggles true→false and fields are cleared', () => {
    const dto = makeDto({
      isBusiness: true,
      businessName: 'ACME Srl',
      vatNumber: '01234567890',
    });
    const values = makeValues({
      isBusiness: false,
      businessName: '',
      vatNumber: '',
    });
    expect(formToPatch(values, dto)).toEqual({
      isBusiness: false,
      businessName: null,
      vatNumber: null,
    });
  });

  // EDGE CASE: voce 10 — when isBusiness stays false the entire time and
  // businessName/vatNumber are empty strings matching already-null DTO fields,
  // the patch must NOT include those null entries (no-op).
  it('does not include null patch entries for already-null DTO fields untouched by user', () => {
    const dto = makeDto({
      isBusiness: false,
      businessName: null,
      vatNumber: null,
    });
    const values = makeValues({
      isBusiness: false,
      businessName: '',
      vatNumber: '',
      firstName: 'Luigi', // user changed only this
    });
    expect(formToPatch(values, dto)).toEqual({ firstName: 'Luigi' });
  });
});
