// DTO for GET /v1/admin/tenants/:id/metrics — Slice 4 per-tenant metrics.

export interface TenantMetrics {
  interventions: { total: number; last30d: number; lastAt: string | null };
  /** Officine staff users of this tenant, non eliminati (deletedAt null). */
  usersTotal: number;
  /** Vehicles created or certified by this tenant. */
  vehiclesTotal: number;
  /** Customers linked to this tenant (non-deleted relations). */
  customersTotal: number;
  /** Deadlines still open or overdue. */
  openDeadlines: number;
  /** Internal-user invitations not yet accepted and not expired. */
  pendingInvitations: number;
}
