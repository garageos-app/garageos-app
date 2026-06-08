import { describe, expect, it } from 'vitest';

import {
  extractOnboardingCompletedAt,
  serializeTenantMe,
} from '../../../../src/lib/dtos/tenant-me.js';

const BASE_ROW = {
  id: 't1',
  businessName: 'Officina Rossi',
  vatNumber: '12345678901',
  email: 'info@rossi.it',
  phone: null,
  addressLine: null,
  city: null,
  province: null,
  postalCode: null,
  status: 'active' as const,
  plan: 'starter',
  billingStatus: 'manual' as const,
  createdAt: new Date('2026-01-15T09:00:00Z'),
};

describe('extractOnboardingCompletedAt', () => {
  it('returns the ISO string when present', () => {
    expect(
      extractOnboardingCompletedAt({ onboardingCompletedAt: '2026-06-08T10:00:00.000Z' }),
    ).toBe('2026-06-08T10:00:00.000Z');
  });
  it('returns null for empty / missing / non-string / array / null settings', () => {
    expect(extractOnboardingCompletedAt({})).toBeNull();
    expect(extractOnboardingCompletedAt({ other: 1 })).toBeNull();
    expect(extractOnboardingCompletedAt({ onboardingCompletedAt: 123 })).toBeNull();
    expect(extractOnboardingCompletedAt([1, 2])).toBeNull();
    expect(extractOnboardingCompletedAt(null)).toBeNull();
  });
});

describe('serializeTenantMe', () => {
  it('adds onboardingCompletedAt and strips raw settings', () => {
    const dto = serializeTenantMe({
      ...BASE_ROW,
      settings: { onboardingCompletedAt: '2026-06-08T10:00:00.000Z', secret: 'x' },
    });
    expect(dto.onboardingCompletedAt).toBe('2026-06-08T10:00:00.000Z');
    expect(dto).not.toHaveProperty('settings');
    expect(dto.businessName).toBe('Officina Rossi');
  });
  it('returns null onboardingCompletedAt when settings is empty', () => {
    const dto = serializeTenantMe({ ...BASE_ROW, settings: {} });
    expect(dto.onboardingCompletedAt).toBeNull();
  });
});
