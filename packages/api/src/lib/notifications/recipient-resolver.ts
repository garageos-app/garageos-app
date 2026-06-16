import type { PrismaClient } from '@garageos/database';
import type { CustomerForNotification } from './types.js';

// Loose tx type — accepts both the full PrismaClient and the transaction
// client provided by withContext. Reads vehicle_ownerships under the
// caller's RLS context (tenantId scope).
type PrismaTxLike = Pick<PrismaClient, 'vehicleOwnership'>;

// Loose tx type for the customer-keyed helper.
type CustomerTxLike = Pick<PrismaClient, 'customer'>;

// BR-158: deleted customers have status='deleted' and email rewritten to
// deleted-<hash>@garageos.it — never notify them.
export function isNotifiableRecipient(
  c: Pick<CustomerForNotification, 'status' | 'email'>,
): boolean {
  if (c.status === 'deleted') return false;
  if (c.email.startsWith('deleted-') && c.email.endsWith('@garageos.it')) return false;
  return true;
}

// BR-040: at most one ownership row per vehicle has ended_at IS NULL.
// BR-158: deleted customers have email rewritten to deleted-<hash>@garageos.it
// — skip the notification rather than spam an alias.
export async function resolveCurrentOwner(
  tx: PrismaTxLike,
  vehicleId: string,
): Promise<CustomerForNotification | null> {
  const ownership = await tx.vehicleOwnership.findFirst({
    where: { vehicleId, endedAt: null },
    include: {
      customer: {
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          isBusiness: true,
          businessName: true,
          notificationPreferences: true,
          status: true,
        },
      },
    },
  });
  if (!ownership) return null;
  const customer = ownership.customer;
  if (!isNotifiableRecipient(customer)) return null;
  return customer as CustomerForNotification;
}

// Resolves a customer by id into the notification-recipient shape.
// Sibling of resolveCurrentOwner for callers that already hold a
// customerId (e.g. the cedente of an ownership transfer, who is no
// longer the vehicle's current owner). Same skips: deleted status
// and BR-158 anonymized email.
export async function resolveCustomerForNotification(
  tx: CustomerTxLike,
  customerId: string,
): Promise<CustomerForNotification | null> {
  const customer = await tx.customer.findUnique({
    where: { id: customerId },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      isBusiness: true,
      businessName: true,
      notificationPreferences: true,
      status: true,
    },
  });
  if (!customer) return null;
  if (!isNotifiableRecipient(customer)) return null;
  return customer as CustomerForNotification;
}
