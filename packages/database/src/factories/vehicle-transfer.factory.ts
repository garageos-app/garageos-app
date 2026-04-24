import { randomUUID } from 'node:crypto';

import { Factory } from 'fishery';

import { prisma } from '../client.js';
import type { Prisma } from '../../prisma/generated/prisma/client/client.js';

// Caller must pass `vehicleId`. `fromCustomerId`/`toCustomerId` are
// nullable by design (BR-044 claim-without-seller leaves `fromCustomerId`
// null until validation). Default status is `pending_recipient` — the
// first active state in the BR-047 partial unique window.

export const VehicleTransferFactory = Factory.define<Prisma.VehicleTransferUncheckedCreateInput>(
  ({ sequence, onCreate }) => {
    onCreate(async (data) => {
      await prisma.vehicleTransfer.create({ data });
      return data;
    });

    // 7-day expiry by default (matches BR-043 timeout). Tests that
    // care about expiry override explicitly.
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    return {
      id: randomUUID(),
      vehicleId: randomUUID(),
      fromCustomerId: null,
      toCustomerId: null,
      transferCode: `TRC-${String(sequence).padStart(8, '0')}`,
      invitedEmail: null,
      method: 'initiated_by_seller',
      status: 'pending_recipient',
      expiresAt,
    };
  },
);

// BR-047 enumerates three "active" statuses — the partial unique index
// keys on exactly these. Traits exist per state so BR-047 tests can
// iterate without repeating the enum names.
export const pendingRecipientTransfer = VehicleTransferFactory.params({
  status: 'pending_recipient',
});
export const pendingSellerConfirmationTransfer = VehicleTransferFactory.params({
  status: 'pending_seller_confirmation',
});
export const pendingValidationTransfer = VehicleTransferFactory.params({
  status: 'pending_validation',
  method: 'claim_without_seller',
});

// Terminal states — these fall outside the BR-047 window, so stacking
// is allowed.
export const completedTransfer = VehicleTransferFactory.params({ status: 'completed' });
export const rejectedTransfer = VehicleTransferFactory.params({ status: 'rejected' });
export const expiredTransfer = VehicleTransferFactory.params({ status: 'expired' });
