import type { PrismaClient } from '@garageos/database';

// BR-151: tenant sees customer PII only if customer_tenant_relations
// has a row for (tenantId, customerId). The read-only endpoints return
// vehicles cross-tenant (BR-150 / vehicles_read USING true), so the PII
// decision has to be made per customer at response-assembly time.
//
// The "application layer enforces PII" design is documented in the RLS
// migration itself (packages/database/prisma/migrations/20260424100000_
// rls_triggers_checks/migration.sql:366-368) — customers_read is
// intentionally permissive because a SELECT policy cannot hide a
// subset of columns.

export interface PiiVisibilityArgs {
  tx: PrismaClient;
  tenantId: string;
  customerIds: string[];
}

export async function resolvePiiVisibility({
  tx,
  tenantId,
  customerIds,
}: PiiVisibilityArgs): Promise<Set<string>> {
  if (customerIds.length === 0) return new Set();
  const unique = Array.from(new Set(customerIds));
  const rows = await tx.customerTenantRelation.findMany({
    where: { tenantId, customerId: { in: unique } },
    select: { customerId: true },
  });
  return new Set(rows.map((r) => r.customerId));
}

export interface CustomerRow {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  isBusiness: boolean;
  businessName: string | null;
  vatNumber: string | null;
}

export type VisibleCustomerDto = CustomerRow & { redacted: false };

export interface RedactedCustomerDto {
  id: string;
  redacted: true;
  displayName: 'Proprietario non in anagrafica';
}

export type CustomerDto = VisibleCustomerDto | RedactedCustomerDto;

// BR-153: redacted form substitutes the placeholder literal required
// by the spec. The id is kept so clients can still key UI rows; every
// other column disappears. TODO(i18n): once the i18n system lands
// (see CLAUDE.md "User-facing strings"), swap this literal for a key.
export function maskCustomer(row: CustomerRow, visible: boolean): CustomerDto {
  if (visible) {
    return { ...row, redacted: false };
  }
  return {
    id: row.id,
    redacted: true,
    displayName: 'Proprietario non in anagrafica',
  };
}
