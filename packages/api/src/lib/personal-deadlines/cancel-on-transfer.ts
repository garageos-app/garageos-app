import { Prisma } from '@garageos/database';
import type { PrismaClient } from '@garageos/database';

// Same tx type the sibling transfer helpers accept (transfer-swap.ts,
// ownership-transfer.ts): either a real client or a transaction client.
type TxClient = Prisma.TransactionClient | PrismaClient;

// BR-297: on vehicle ownership change, cancel the previous owner's active
// (open|overdue) personal deadlines on that vehicle and their pending
// reminders. completed/cancelled deadlines are immutable history (untouched).
//
// Runs INSIDE the caller's existing transaction (tx) so it shares the same
// atomic unit as the ownership swap: if the transfer rolls back, so does the
// cancellation. The personal_deadlines RLS is USING(true), so the write is
// permitted under both the customer flow's { role: 'user' } context and the
// officina flow's { role: 'admin' } context.
//
// Sequential by design — NEVER Promise.all over a single tx (the pg adapter
// warns and statements can interleave on one connection).
export async function cancelPersonalDeadlinesForVehicleTransfer(
  tx: TxClient,
  args: { vehicleId: string; previousOwnerCustomerId: string },
): Promise<{ cancelledDeadlines: number; cancelledReminders: number }> {
  const { vehicleId, previousOwnerCustomerId } = args;

  // Select the previous owner's active deadlines on this vehicle. Scoped by
  // customerId so a different customer's deadlines on the same vehicle (e.g. a
  // historical owner) are never touched.
  const ids = (
    await tx.personalDeadline.findMany({
      where: {
        vehicleId,
        customerId: previousOwnerCustomerId,
        status: { in: ['open', 'overdue'] },
      },
      select: { id: true },
    })
  ).map((d) => d.id);

  if (ids.length === 0) {
    return { cancelledDeadlines: 0, cancelledReminders: 0 };
  }

  // Cancel ONLY the still-pending reminders of those deadlines; sent/failed/
  // cancelled reminders are terminal history and are left untouched.
  const rem = await tx.personalDeadlineReminder.updateMany({
    where: { personalDeadlineId: { in: ids }, deliveryStatus: 'pending' },
    data: { deliveryStatus: 'cancelled', failureReason: 'ownership_transferred' },
  });

  const dl = await tx.personalDeadline.updateMany({
    where: { id: { in: ids } },
    data: { status: 'cancelled' },
  });

  return { cancelledDeadlines: dl.count, cancelledReminders: rem.count };
}
