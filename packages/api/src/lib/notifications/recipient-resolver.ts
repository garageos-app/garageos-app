import type { PrismaClient } from '@garageos/database';
import type { CustomerForNotification } from './types.js';

// Loose tx type — accepts both the full PrismaClient and the transaction
// client provided by withContext. Reads vehicle_ownerships under the
// caller's RLS context (tenantId scope).
type PrismaTxLike = Pick<PrismaClient, 'vehicleOwnership'>;

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
  if (customer.status === 'deleted') return null;
  if (customer.email.startsWith('deleted-') && customer.email.endsWith('@garageos.it')) {
    return null;
  }
  return customer as CustomerForNotification;
}
