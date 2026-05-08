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
    marketing: false,
  },
  push: {
    intervention_updates: true,
    deadline_reminder: true,
    transfer_invitation: true,
    dispute_response: true,
  },
} as const;

export type NotificationPreferences = typeof DEFAULT_NOTIFICATION_PREFERENCES;
