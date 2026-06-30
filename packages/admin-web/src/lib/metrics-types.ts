// Mirror of the backend GET /v1/admin/metrics DTO
// (packages/api/src/lib/dtos/platform-metrics.ts). Keep in sync.

export interface WeeklyTrendPoint {
  week: string; // YYYY-MM-DD (Monday of the ISO week)
  count: number;
}

export interface PlatformMetrics {
  tenants: { total: number; active: number; suspended: number };
  usersTotal: number;
  interventions: { total: number; last30d: number };
  vehiclesTotal: number;
  customersTotal: number;
  trend: WeeklyTrendPoint[];
}
