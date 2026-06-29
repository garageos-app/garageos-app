// Wire type (mirrors TenantAdminListItem in packages/api/src/lib/dtos/tenant-admin.ts).
// Kept in lib so both pages and lib/tenant-status share a single definition
// without creating an inverted page→lib dependency.

export interface TenantAdminListItem {
  id: string;
  businessName: string;
  vatNumber: string;
  email: string;
  status: 'active' | 'suspended' | 'pending' | 'cancelled';
  createdAt: string; // ISO-8601
  owner: { email: string; invitationStatus: 'pending' | 'accepted' | 'expired' } | null;
}
