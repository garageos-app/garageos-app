import type { Prisma } from '@garageos/database';

// BR-226 — default customer notification preferences. Applied at signup
// time (POST /v1/auth/signup) and any other path that creates a Customer
// row from scratch. Customer can later override via F-CLI-005 settings.
//
// Schema-side default in `packages/database/prisma/schema.prisma` is the
// empty object `{}`; the application is the source of truth for the
// shape because BR-226 lists explicit channel × event toggles, and the
// list will grow (e.g. SMS in v1.1).
export const DEFAULT_NOTIFICATION_PREFERENCES = {
  email: {
    intervention_updates: true,
    deadline_reminder: true,
    transfer_invitation: true,
    dispute_response: true,
    ownership_transfer: true,
    marketing: false,
  },
  push: {
    intervention_updates: true,
    deadline_reminder: true,
    transfer_invitation: true,
    dispute_response: true,
    ownership_transfer: true,
  },
} as const;

export type NotificationPreferences = typeof DEFAULT_NOTIFICATION_PREFERENCES;

// The subset of email channels a customer may edit via F-CLI-005.
// Excludes transfer_invitation (BR-260: always sent, not disablable),
// dispute_response (no consumer yet), and push.* (no delivery yet —
// F-CLI-302). These remain in storage but outside the editable surface.
export const EDITABLE_EMAIL_KEYS = [
  'intervention_updates',
  'deadline_reminder',
  'ownership_transfer',
  'marketing',
] as const;

export type EditableEmailKey = (typeof EDITABLE_EMAIL_KEYS)[number];

export interface ProjectedNotificationPreferences {
  email: Record<EditableEmailKey, boolean>;
}

// Effective preferences for the editable keys: stored value when it is a
// boolean, otherwise the BR-226 default. Mirrors the defensive fallback in
// lib/notifications/preferences.ts (missing/malformed/partial -> default).
export function projectNotificationPreferences(
  stored: Prisma.JsonValue,
): ProjectedNotificationPreferences {
  const email =
    stored && typeof stored === 'object' && !Array.isArray(stored)
      ? (stored as Record<string, unknown>).email
      : undefined;
  const emailObj =
    email && typeof email === 'object' && !Array.isArray(email)
      ? (email as Record<string, unknown>)
      : {};

  const out = {} as Record<EditableEmailKey, boolean>;
  for (const key of EDITABLE_EMAIL_KEYS) {
    const value = emailObj[key];
    out[key] = typeof value === 'boolean' ? value : DEFAULT_NOTIFICATION_PREFERENCES.email[key];
  }
  return { email: out };
}
