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

export interface VehicleForEmail {
  id: string;
  plate: string;
}

// DeadlineReminderType mirrors the Prisma-generated enum values (enums.ts).
// Redeclared locally (same pattern as scheduler-client.ts and compute-reminders.ts)
// so this lib does not pull in a Prisma runtime dependency.
export type DeadlineReminderType = 't_minus_30' | 't_minus_7' | 't_zero' | 'km_reached';

export interface DeadlineReminderForEmail {
  deadlineId: string;
  reminderType: DeadlineReminderType;
  dueDate: string; // ISO date YYYY-MM-DD
  dueOdometerKm: number | null;
  vehicleId: string;
  vehicleLicensePlate: string;
  interventionTypeName: string;
  description: string | null;
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
    }
  | ({ type: 'deadline.reminder' } & DeadlineReminderForEmail)
  | {
      type: 'ownership.transferred';
      vehicle: VehicleForEmail;
      tenant: TenantForEmail;
      transferReason: 'purchase' | 'inheritance' | 'company_assignment' | 'other';
      transferredAt: string; // ISO 8601
    };

export type EmailEnabledKey =
  | 'intervention_updates'
  | 'deadline_reminder'
  | 'transfer_invitation'
  | 'dispute_response'
  | 'ownership_transfer';

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
