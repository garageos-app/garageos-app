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

// BR-157: the creation push title interpolates the vehicle model, so the
// created event carries more vehicle fields than ownership.transferred.
export interface VehicleForCreatedEmail {
  id: string;
  plate: string;
  make: string;
  model: string;
}

// TransferReason is kept here (not imported from lib/ownership-transfer.ts) to keep
// this module free of Prisma-coupled imports — same boundary pattern as DeadlineReminderType.
export type TransferReason = 'purchase' | 'inheritance' | 'company_assignment' | 'other';

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
      type: 'intervention.created';
      intervention: InterventionForEmail; // cancelledReason is always null here
      interventionTypeName: string; // interventionType.nameIt — BR-157 push body
      vehicle: VehicleForCreatedEmail;
      tenant: TenantForEmail;
    }
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
      transferReason: TransferReason;
      transferredAt: string; // ISO 8601
    };

export type EmailEnabledKey =
  | 'intervention_updates'
  | 'deadline_reminder'
  | 'transfer_invitation'
  | 'dispute_response'
  | 'ownership_transfer';

// The three preference keys an event can map to. Subset of EmailEnabledKey,
// and all present in DEFAULT_NOTIFICATION_PREFERENCES.push — so it types both
// the email and push gating lookups.
export type NotificationEventPrefKey =
  | 'intervention_updates'
  | 'deadline_reminder'
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

export interface PushDispatchResult {
  attempted: number; // active, valid tokens we tried
  sent: number; // tickets with status 'ok'
  skipped?: 'pref-off' | 'no-token';
  deactivated: number; // tokens marked active=false (BR-254)
  appInstalledCleared: boolean; // true when the last active token died -> app_installed=false
  error?: string; // channel-level send failure (whole batch)
}

export interface DispatchResult {
  // EMAIL outcome — semantics unchanged (scheduler derives delivery_status).
  sent: boolean;
  skipped?: 'pref-off' | 'no-recipient' | 'invalid-email';
  error?: string;
  // PUSH outcome — additive, best-effort, logging-only. Present only when a
  // DB context (tx or app) was supplied to dispatchNotification.
  push?: PushDispatchResult;
}
