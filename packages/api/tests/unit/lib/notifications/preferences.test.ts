import { describe, expect, it } from 'vitest';
import { isEmailEnabled } from '../../../../src/lib/notifications/preferences.js';
import type { CustomerForNotification } from '../../../../src/lib/notifications/types.js';

function makeCustomer(prefs: unknown): CustomerForNotification {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    email: 'mario@test.it',
    firstName: 'Mario',
    lastName: 'Rossi',
    isBusiness: false,
    businessName: null,
    notificationPreferences: prefs as never,
    status: 'active',
  };
}

describe('isEmailEnabled', () => {
  it('returns true when prefs is empty object (default fallback)', () => {
    expect(isEmailEnabled(makeCustomer({}), 'intervention_updates')).toBe(true);
  });

  it('returns true when email key absent from prefs', () => {
    expect(isEmailEnabled(makeCustomer({ push: {} }), 'intervention_updates')).toBe(true);
  });

  it('returns true when intervention_updates absent from email subkey', () => {
    expect(
      isEmailEnabled(makeCustomer({ email: { deadline_reminder: false } }), 'intervention_updates'),
    ).toBe(true);
  });

  it('returns false when explicitly disabled', () => {
    expect(
      isEmailEnabled(
        makeCustomer({ email: { intervention_updates: false } }),
        'intervention_updates',
      ),
    ).toBe(false);
  });

  it('returns true when explicitly enabled', () => {
    expect(
      isEmailEnabled(
        makeCustomer({ email: { intervention_updates: true } }),
        'intervention_updates',
      ),
    ).toBe(true);
  });

  it('falls back to default on null prefs', () => {
    expect(isEmailEnabled(makeCustomer(null), 'intervention_updates')).toBe(true);
  });

  it('falls back to default on array (malformed)', () => {
    expect(isEmailEnabled(makeCustomer([]), 'intervention_updates')).toBe(true);
  });

  it('falls back to default on non-boolean value', () => {
    expect(
      isEmailEnabled(
        makeCustomer({ email: { intervention_updates: 'yes' } }),
        'intervention_updates',
      ),
    ).toBe(true);
  });

  it('respects different keys independently', () => {
    expect(
      isEmailEnabled(
        makeCustomer({ email: { intervention_updates: false, deadline_reminder: true } }),
        'deadline_reminder',
      ),
    ).toBe(true);
  });
});
