// Mobile mirror of the API projection in
// packages/api/src/lib/notification-preferences.ts. The editable surface is the
// 4 email keys a customer may toggle (F-CLI-005); transfer_invitation (BR-260),
// dispute_response, and push.* are intentionally excluded.

export const EDITABLE_EMAIL_KEYS = [
  'intervention_updates',
  'deadline_reminder',
  'ownership_transfer',
  'marketing',
] as const;

export type EditableEmailKey = (typeof EDITABLE_EMAIL_KEYS)[number];

export interface NotificationPreferences {
  email: Record<EditableEmailKey, boolean>;
}
