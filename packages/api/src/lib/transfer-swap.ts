import { Prisma } from '@garageos/database';
import type { PrismaClient } from '@garageos/database';

import { businessError } from './business-error.js';

// Atomic ownership swap for the customer-confirmed transfer (BR-043 step 4).
//
// Compare-and-swap on the transfer status guards against a concurrent
// confirm; the partial-unique index uq_ownership_vehicle_active (BR-040)
// guards the new ownership row. No AccessLog is written: the customer flow
// has no tenant/user actor (mirrors the claim path in me-vehicles.ts). The
// whole call runs inside the withContext transaction, so any throw after the
// status flip rolls the flip back.
//
// Lock order (memory feedback_code_review_lock_graph_analysis):
//   vehicle_transfers -> vehicle_ownerships
//
// performOwnershipTransfer (lib/ownership-transfer.ts, F-OFF-110) is the
// officina-mediated single-step variant and is intentionally NOT reused:
// it scopes by tenant, resolves/creates the recipient, CREATES the transfer
// row and writes an AccessLog — none of which fit the customer flow.

type TxClient = Prisma.TransactionClient | PrismaClient;

export interface ConfirmSwapInput {
  transferId: string;
  vehicleId: string;
  fromCustomerId: string;
  toCustomerId: string;
  now: Date;
}

export async function confirmTransferSwap(tx: TxClient, input: ConfirmSwapInput): Promise<void> {
  const { transferId, vehicleId, fromCustomerId, toCustomerId, now } = input;

  // Step 1: CAS the transfer to completed. Leaving pending_seller_confirmation
  // also drops the row out of the uq_transfer_vehicle_active predicate,
  // freeing the BR-047 active-transfer slot.
  const cas = await tx.vehicleTransfer.updateMany({
    where: { id: transferId, status: 'pending_seller_confirmation' },
    data: { status: 'completed', completedAt: now },
  });
  if (cas.count === 0) {
    // A concurrent confirm won the race and already advanced the status.
    throw businessError(
      'transfer.confirmation.not_pending_seller',
      422,
      'Trasferimento non in attesa di conferma del cedente.',
    );
  }

  // Step 2: close the seller's current active ownership.
  const closed = await tx.vehicleOwnership.updateMany({
    where: { vehicleId, customerId: fromCustomerId, endedAt: null },
    data: { endedAt: now, transferReason: 'purchase', transferNotes: null },
  });
  if (closed.count === 0) {
    // Near-unreachable: the pending transfer held the BR-047 slot, blocking
    // any competing claim/officina transfer. Defensive guard.
    throw businessError(
      'transfer.confirmation.ownership_conflict',
      409,
      'Stato proprieta del veicolo cambiato: riprova.',
    );
  }

  // Step 3: open the new ownership for the recipient.
  try {
    await tx.vehicleOwnership.create({
      data: { vehicleId, customerId: toCustomerId, startedAt: now },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw businessError(
        'transfer.confirmation.ownership_conflict',
        409,
        'Stato proprieta del veicolo cambiato: riprova.',
      );
    }
    throw err;
  }
}
