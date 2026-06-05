// Mirrors the GET /v1/me/vehicles/:id/access-log response (camelCase, like
// /me, /me/vehicles, /me/deadlines). BR-155 redaction (no ip/userAgent/ids) is
// enforced server-side; mechanicName is present only when a customer_tenant_relation
// exists (BR-151). Cursor pagination: meta.cursor is set only when has_more.
export type CustomerAccessAction = 'view' | 'new_intervention';

export interface CustomerAccessEntry {
  action: CustomerAccessAction;
  tenantName: string;
  locationCity: string | null;
  occurredAt: string;
  mechanicName?: string;
}

export interface AccessLogPage {
  data: CustomerAccessEntry[];
  meta: { has_more: boolean; cursor?: string };
}
