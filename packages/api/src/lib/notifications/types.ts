// Discriminated union of notification events H1 dispatches. H2 will
// extend with 'dispute.response'. Each variant carries the data
// templates need — keeping the dispatcher pure (no DB I/O).

import type { Prisma } from '@garageos/database';

export interface InterventionForEmail {
  id: string;
  vehicleId: string;
  title: string | null;
  description: string | null;
  cancelledReason: string | null;
}

export interface RevisionForEmail {
  id: string;
  revisedAt: Date;
  reason: string | null;
  // changes is the JSON diff written into intervention_revisions.changes.
  // Templates render a count of fields changed, not the full diff.
  changes: Prisma.JsonValue;
}

export interface TenantForEmail {
  id: string;
  businessName: string;
}

export type NotificationEvent =
  | {
      type: 'intervention.revised';
      intervention: InterventionForEmail;
      revision: RevisionForEmail;
      tenant: TenantForEmail;
    }
  | {
      type: 'intervention.cancelled';
      intervention: InterventionForEmail;
      tenant: TenantForEmail;
    };

export type EmailEnabledKey =
  | 'intervention_updates'
  | 'deadline_reminder'
  | 'transfer_invitation'
  | 'dispute_response';

export interface CustomerForNotification {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  isBusiness: boolean;
  businessName: string | null;
  notificationPreferences: Prisma.JsonValue;
  status: 'active' | 'pending_verification' | 'deleted';
}

export interface DispatchResult {
  sent: boolean;
  skipped?: 'pref-off' | 'no-recipient' | 'invalid-email';
  error?: string;
}
