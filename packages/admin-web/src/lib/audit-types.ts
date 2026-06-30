// Mirror of GET /v1/admin/audit-logs wire shape
// (packages/api/src/lib/dtos/audit-log.ts). Keep in sync.

export interface AuditLogItem {
  id: string;
  createdAt: string; // ISO-8601
  /** null = platform-level event (no tenant); businessName null = hard-deleted tenant. */
  tenant: { id: string; businessName: string | null } | null;
  actorType: 'user' | 'customer' | 'system' | 'admin';
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  ipAddress: string | null;
  metadata: unknown;
}

export interface AuditLogPage {
  items: AuditLogItem[];
  nextCursor: string | null;
}

export const ACTOR_TYPE_LABELS: Record<AuditLogItem['actorType'], string> = {
  user: 'Utente officina',
  customer: 'Cliente',
  system: 'Sistema',
  admin: 'Piattaforma',
};

// Curated list of known actions (mirrors the ~25 strings written across the API).
// Actions not listed still appear in the table; only the dropdown completeness drifts.
export const AUDIT_ACTIONS: string[] = [
  'create',
  'update',
  'cancel',
  'view',
  'deny',
  'respond',
  'search_match',
  'ownership_transfer',
  'vehicle_registered',
  'customer_signup',
  'tenant_created',
  'tenant_profile_updated',
  'tenant_suspended',
  'tenant_reactivated',
  'tenant_invitation_regenerated',
  'user_invited',
  'user_invitation_created',
  'user_invitation_accepted',
  'user_invitation_revoked',
  'user_role_changed',
  'user_status_changed',
  'user_reactivated',
  'user_soft_deleted',
  'user_password_changed',
  'user_password_reset',
];
