// DTO for GET /v1/admin/metrics — Slice 4 platform-admin aggregate metrics.

export interface WeeklyTrendPoint {
  /** Monday of the ISO week, formatted YYYY-MM-DD. */
  week: string;
  count: number;
}

export interface PlatformMetrics {
  tenants: { total: number; active: number; suspended: number };
  /** Officine staff users with status = active (platform-wide). */
  usersTotal: number;
  interventions: { total: number; last30d: number };
  vehiclesTotal: number;
  customersTotal: number;
  /** Interventions per ISO week, exactly 8 entries, ascending, zero-filled. */
  trend: WeeklyTrendPoint[];
}
