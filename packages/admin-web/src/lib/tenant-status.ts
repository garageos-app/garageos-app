// Badge label + variant maps for TenantStatus and InvitationStatus fields.
// Shared by TenantList (T7) and future row-action dialogs (T8).
// Italian labels are inline — admin-web has no i18n framework.

import type { TenantAdminListItem } from '@/lib/tenant-types';

type TenantStatus = TenantAdminListItem['status'];
type InvitationStatus = NonNullable<TenantAdminListItem['owner']>['invitationStatus'];

// shadcn Badge variants: default | secondary | destructive | outline
export const STATUS_BADGE: Record<
  TenantStatus,
  { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }
> = {
  active: { label: 'Attiva', variant: 'default' },
  suspended: { label: 'Sospesa', variant: 'destructive' },
  pending: { label: 'In attesa', variant: 'secondary' },
  cancelled: { label: 'Cancellata', variant: 'outline' },
};

export const INVITATION_BADGE: Record<
  InvitationStatus,
  { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }
> = {
  pending: { label: 'In attesa', variant: 'secondary' },
  accepted: { label: 'Accettato', variant: 'default' },
  expired: { label: 'Scaduto', variant: 'destructive' },
};
