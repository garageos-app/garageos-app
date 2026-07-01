// Wire types for the TenantDetail page (B2/B3).
// TenantProfile mirrors TenantMeDto (packages/api/src/lib/dtos/tenant-me.ts).
// AdminUser mirrors UserAdminWireDto (packages/api/src/lib/dtos/user-admin.ts).
// InviteResult mirrors the POST /v1/admin/tenants/:id/users/invite response body.
// All date fields are ISO-8601 strings (wire representation, not Date objects).

export interface TenantProfile {
  id: string;
  businessName: string;
  vatNumber: string;
  email: string;
  phone: string | null;
  addressLine: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  status: 'active' | 'suspended' | 'pending' | 'cancelled';
  plan: string;
  billingStatus: string;
  createdAt: string;
  onboardingCompletedAt: string | null;
}

export interface AdminUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: 'super_admin' | 'mechanic';
  status: 'active' | 'inactive';
  phone: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface InviteResult {
  email: string;
  role: 'super_admin' | 'mechanic';
  expiresAt: string;
  emailSent: boolean;
  magicLinkUrl: string;
}
