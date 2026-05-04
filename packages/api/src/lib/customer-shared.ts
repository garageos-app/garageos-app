import type { Prisma } from '@garageos/database';

// Fields the customer self-projection returns to the customer themselves
// (e.g. signup 201 body, future GET /v1/me). Excludes audit fields and
// fields the customer cannot see about themselves yet — those are added
// when their PATCH /v1/me/profile endpoint ships (F-CLI-004).
export const customerSelfSelect = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  phone: true,
  status: true,
  createdAt: true,
} as const satisfies Prisma.CustomerSelect;

// Internal type of a row Prisma returns when select=customerSelfSelect.
export interface CustomerSelfRow {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  status: 'active' | 'pending_verification' | 'deleted';
  createdAt: Date;
}

// Wire-format projection (camelCase, ISO 8601 createdAt). Centralised
// here so the shape is consistent across signup + future self endpoints.
export function projectCustomerSelf(row: CustomerSelfRow): {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  status: string;
  createdAt: string;
} {
  return {
    id: row.id,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    phone: row.phone,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}
