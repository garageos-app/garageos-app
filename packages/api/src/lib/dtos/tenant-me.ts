import type { Prisma } from '@garageos/database';

// Shared select for GET /v1/tenants/me + PATCH /v1/tenants/me response.
// Includes both editable and read-only fields. Editable subset is
// defined in the PATCH route's Zod body (businessName, addressLine,
// city, province, postalCode, phone, email). Read-only fields in the
// response: vatNumber, status, plan, billingStatus, createdAt — needed
// by the frontend for display (e.g. P. IVA shown above the form) but
// not user-editable through this slice.
export const TENANT_ME_SELECT = {
  id: true,
  businessName: true,
  vatNumber: true,
  email: true,
  phone: true,
  addressLine: true,
  city: true,
  province: true,
  postalCode: true,
  status: true,
  plan: true,
  billingStatus: true,
  createdAt: true,
} as const satisfies Prisma.TenantSelect;

export type TenantMeDto = Prisma.TenantGetPayload<{ select: typeof TENANT_ME_SELECT }>;
