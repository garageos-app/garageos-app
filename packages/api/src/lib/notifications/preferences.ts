import { DEFAULT_NOTIFICATION_PREFERENCES } from '../notification-preferences.js';
import type { CustomerForNotification, EmailEnabledKey } from './types.js';

// Source of truth for "should this customer receive emails of type X".
// Falls back to DEFAULT_NOTIFICATION_PREFERENCES when the customer's
// stored prefs are missing/malformed/partial — single fallback path
// (no scattered ternaries in routes).
export function isEmailEnabled(customer: CustomerForNotification, key: EmailEnabledKey): boolean {
  const prefs = customer.notificationPreferences;
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) {
    return DEFAULT_NOTIFICATION_PREFERENCES.email[key];
  }
  const email = (prefs as Record<string, unknown>).email;
  if (!email || typeof email !== 'object' || Array.isArray(email)) {
    return DEFAULT_NOTIFICATION_PREFERENCES.email[key];
  }
  const value = (email as Record<string, unknown>)[key];
  if (typeof value !== 'boolean') {
    return DEFAULT_NOTIFICATION_PREFERENCES.email[key];
  }
  return value;
}
