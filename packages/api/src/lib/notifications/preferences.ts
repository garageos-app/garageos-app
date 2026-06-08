import { DEFAULT_NOTIFICATION_PREFERENCES } from '../notification-preferences.js';
import type {
  CustomerForNotification,
  EmailEnabledKey,
  NotificationEventPrefKey,
} from './types.js';

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

// Push counterpart of isEmailEnabled. Reads prefs.push[key] with the same
// defensive fallback (missing/malformed/partial -> BR-226 default). In PR2
// push.* is not yet editable (F-CLI-005 PR3), so this is effectively the
// BR-226 default (true) unless the stored JSON was hand-set.
export function isPushEnabled(
  customer: CustomerForNotification,
  key: NotificationEventPrefKey,
): boolean {
  const prefs = customer.notificationPreferences;
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) {
    return DEFAULT_NOTIFICATION_PREFERENCES.push[key];
  }
  const push = (prefs as Record<string, unknown>).push;
  if (!push || typeof push !== 'object' || Array.isArray(push)) {
    return DEFAULT_NOTIFICATION_PREFERENCES.push[key];
  }
  const value = (push as Record<string, unknown>)[key];
  if (typeof value !== 'boolean') {
    return DEFAULT_NOTIFICATION_PREFERENCES.push[key];
  }
  return value;
}
