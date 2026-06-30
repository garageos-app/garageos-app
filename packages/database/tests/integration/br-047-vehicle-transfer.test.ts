import { beforeEach, describe, expect, it } from 'vitest';

import { createTenant, createVehicle, resetDb } from './helpers.js';
import { pgAdmin } from './setup.js';

// BR-047 — one active VehicleTransfer per vehicle. Enforcement:
// partial unique index `uq_transfer_vehicle_active` keyed on vehicle_id
// WHERE status IN ('pending_recipient', 'pending_seller_confirmation',
// 'pending_validation'). Terminal states (completed / rejected /
// expired) are outside the window and allow a new active transfer.

describe('BR-047 — single active transfer per vehicle', () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function insertTransfer(vehicleId: string, status: string, seq: number): Promise<void> {
    await pgAdmin.query(
      `INSERT INTO vehicle_transfers
         (id, vehicle_id, transfer_code, method, status, expires_at, created_at, updated_at)
       VALUES
         (gen_random_uuid(), $1, $2, 'initiated_by_seller'::"TransferMethod",
          $3::"TransferStatus", NOW() + INTERVAL '7 days', NOW(), NOW())`,
      [vehicleId, `TRC-${Date.now()}-${seq}`, status],
    );
  }

  const ACTIVE_STATUSES = [
    'pending_recipient',
    'pending_seller_confirmation',
    'pending_validation',
  ] as const;

  const TERMINAL_STATUSES = ['completed', 'rejected', 'expired'] as const;

  it.each(ACTIVE_STATUSES)(
    'rejects a second active transfer when an existing one is in %s',
    async (firstStatus) => {
      const { tenantId } = await createTenant();
      const { vehicleId } = await createVehicle({ tenantId, status: 'certified' });

      await insertTransfer(vehicleId, firstStatus, 1);

      await expect(insertTransfer(vehicleId, 'pending_recipient', 2)).rejects.toThrow(
        /duplicate key|unique/i,
      );
    },
  );

  it.each(TERMINAL_STATUSES)(
    'allows a new active transfer after a previous %s transfer',
    async (terminalStatus) => {
      const { tenantId } = await createTenant();
      const { vehicleId } = await createVehicle({ tenantId, status: 'certified' });

      await insertTransfer(vehicleId, terminalStatus, 1);
      await expect(insertTransfer(vehicleId, 'pending_recipient', 2)).resolves.not.toThrow();
    },
  );

  it('allows concurrent active transfers on different vehicles', async () => {
    const { tenantId } = await createTenant();
    const { vehicleId: v1 } = await createVehicle({ tenantId, status: 'certified' });
    const { vehicleId: v2 } = await createVehicle({ tenantId, status: 'certified' });

    await insertTransfer(v1, 'pending_recipient', 1);
    await expect(insertTransfer(v2, 'pending_recipient', 2)).resolves.not.toThrow();
  });

  it('transitioning an active transfer to completed frees the slot for a new one', async () => {
    const { tenantId } = await createTenant();
    const { vehicleId } = await createVehicle({ tenantId, status: 'certified' });

    await insertTransfer(vehicleId, 'pending_recipient', 1);

    await pgAdmin.query(
      `UPDATE vehicle_transfers
         SET status = 'completed'::"TransferStatus", completed_at = NOW()
       WHERE vehicle_id = $1`,
      [vehicleId],
    );

    await expect(insertTransfer(vehicleId, 'pending_recipient', 2)).resolves.not.toThrow();
  });

  it('rejects updating a terminal transfer back into the active window when another is already active', async () => {
    // Demonstrates the index catches the inverse motion too: if a
    // completed transfer is reactivated to `pending_recipient` while
    // another active transfer already exists, the UPDATE must fail.
    const { tenantId } = await createTenant();
    const { vehicleId } = await createVehicle({ tenantId, status: 'certified' });

    const { rows } = await pgAdmin.query<{ id: string }>(
      `INSERT INTO vehicle_transfers
         (id, vehicle_id, transfer_code, method, status, expires_at, created_at, updated_at)
       VALUES
         (gen_random_uuid(), $1, 'TRC-COMPLETED-1', 'initiated_by_seller'::"TransferMethod",
          'completed'::"TransferStatus", NOW() + INTERVAL '7 days', NOW(), NOW())
       RETURNING id`,
      [vehicleId],
    );
    const completedTransferId = rows[0]!.id;

    // Active transfer for the same vehicle.
    await insertTransfer(vehicleId, 'pending_recipient', 2);

    await expect(
      pgAdmin.query(
        `UPDATE vehicle_transfers
           SET status = 'pending_recipient'::"TransferStatus"
         WHERE id = $1`,
        [completedTransferId],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });
});
