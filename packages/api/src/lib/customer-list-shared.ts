import type { Prisma } from '@garageos/database';

// Select shape for GET /v1/customers (list). vehicleCount uses a Prisma
// filtered relation count on active ownerships (endedAt null) — matching
// the detail endpoint, whose `vehicles` array is the customer's active
// ownerships regardless of tenant. lastInterventionAt is the denormalized
// per-tenant CTR column; the route handler injects the tenant `where` on
// tenantRelations (mirrors customers-detail.ts).
export const customerListSelect = {
  id: true,
  firstName: true,
  lastName: true,
  phone: true,
  isBusiness: true,
  businessName: true,
  _count: { select: { ownerships: { where: { endedAt: null } } } },
  tenantRelations: {
    select: { lastInterventionAt: true },
  },
} as const satisfies Prisma.CustomerSelect;

// Concrete row shape Prisma returns for customerListSelect with the
// tenant-filtered tenantRelations. The CTR array is never empty when the
// outer find succeeds (the where filters tenantRelations.some).
export interface CustomerListRow {
  id: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  isBusiness: boolean;
  businessName: string | null;
  _count: { ownerships: number };
  tenantRelations: Array<{ lastInterventionAt: Date | null }>;
}

export interface CustomerListItemDto {
  id: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  isBusiness: boolean;
  businessName: string | null;
  vehicleCount: number;
  lastInterventionAt: string | null;
}

export function projectCustomerListRow(row: CustomerListRow): CustomerListItemDto {
  // tenantRelations[0] guaranteed present: the outer find filters by
  // tenantRelations.some({ tenantId }). Defensive optional chaining keeps
  // tsc strict-happy without runtime cost.
  return {
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
    phone: row.phone,
    isBusiness: row.isBusiness,
    businessName: row.businessName,
    vehicleCount: row._count.ownerships,
    lastInterventionAt: row.tenantRelations[0]?.lastInterventionAt?.toISOString() ?? null,
  };
}
