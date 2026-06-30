// BR-155 — the owning customer sees the audit trail of accesses to their
// vehicle in a strictly redacted shape: tenant name, action type, timestamp,
// and (only if a customer_tenant_relation exists, BR-151) the mechanic's name.
// IP address, user agent, and all internal ids are never exposed.
//
// sede-unica: location city removed (Location table dropped in migration).
//
// Pure function: the route resolves the relation set and passes it in, so
// this stays DB-free and unit-testable.

export type CustomerAccessAction = 'view' | 'new_intervention';

export interface CustomerAccessLogEntry {
  action: CustomerAccessAction;
  tenantName: string;
  occurredAt: string;
  mechanicName?: string;
}

export interface RawCustomerAccessLogRow {
  // `action` is constrained upstream to the audit's customer-visible set
  // ('view' | 'create') by the route's where-filter.
  action: string;
  createdAt: Date;
  tenant: { id: string; businessName: string };
  user: { firstName: string; lastName: string };
}

export function serializeCustomerAccessLog(
  rows: RawCustomerAccessLogRow[],
  relationTenantIds: Set<string>,
): CustomerAccessLogEntry[] {
  return rows.map((r) => {
    const entry: CustomerAccessLogEntry = {
      action: r.action === 'view' ? 'view' : 'new_intervention',
      tenantName: r.tenant.businessName,
      occurredAt: r.createdAt.toISOString(),
    };
    // BR-151/BR-155: mechanic name only for tenants the customer relates to.
    if (relationTenantIds.has(r.tenant.id)) {
      entry.mechanicName = `${r.user.firstName} ${r.user.lastName}`;
    }
    return entry;
  });
}
