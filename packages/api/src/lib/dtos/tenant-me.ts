import type { Prisma } from '@garageos/database';

// Shared select for GET /v1/tenants/me + PATCH /v1/tenants/me response.
// Includes both editable and read-only fields. Editable subset is
// defined in the PATCH route's Zod body (businessName, addressLine,
// city, province, postalCode, phone, email). Read-only fields in the
// response: vatNumber, status, plan, billingStatus, createdAt — needed
// by the frontend for display (e.g. P. IVA shown above the form) but
// not user-editable through this slice.
//
// settings is intentionally NOT in this select — it is selected
// separately (TENANT_ME_SELECT_WITH_SETTINGS) only to derive the
// onboarding flag, and stripped by serializeTenantMe before responding.
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

// Adds settings so routes can derive onboardingCompletedAt. The raw JSON
// never reaches the response — serializeTenantMe omits it.
export const TENANT_ME_SELECT_WITH_SETTINGS = {
  ...TENANT_ME_SELECT,
  settings: true,
} as const satisfies Prisma.TenantSelect;

type TenantRowWithSettings = Prisma.TenantGetPayload<{
  select: typeof TENANT_ME_SELECT_WITH_SETTINGS;
}>;

export type TenantMeDto = Prisma.TenantGetPayload<{ select: typeof TENANT_ME_SELECT }> & {
  onboardingCompletedAt: string | null;
};

// Pure: read settings.onboardingCompletedAt if it is a string, else null.
// See F-OFF-002 — the onboarding flag lives in tenant.settings JSON (no
// migration).
export function extractOnboardingCompletedAt(settings: Prisma.JsonValue): string | null {
  if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
    const value = (settings as Record<string, unknown>).onboardingCompletedAt;
    if (typeof value === 'string') return value;
  }
  return null;
}

// Pure: strip raw settings, expose derived onboardingCompletedAt.
export function serializeTenantMe(row: TenantRowWithSettings): TenantMeDto {
  const { settings, ...rest } = row;
  return { ...rest, onboardingCompletedAt: extractOnboardingCompletedAt(settings) };
}
