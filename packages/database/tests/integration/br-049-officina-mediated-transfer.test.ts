import { beforeEach, describe, expect, it } from 'vitest';

import {
  createCustomer,
  createTenantWithLocation,
  createUser,
  createVehicle,
  createVehicleOwnership,
  resetDb,
} from './helpers.js';
import { pgAdmin } from './setup.js';

// BR-049 — Officina-mediated single-step vehicle transfer.
// Atomic transaction: close current ownership, open new ownership for
// recipient, write VehicleTransfer audit row with status='completed' and
// method='officina_mediated', write AccessLog with action='ownership_transfer'.
// Spec ref: docs/superpowers/specs/2026-05-21-f-off-110-officina-mediated-transfer-design.md

describe('BR-049 — officina-mediated single-step transfer', () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function executeTransferSql(
    vehicleId: string,
    fromCustomerId: string,
    toCustomerId: string,
    reason: 'purchase' | 'inheritance' | 'company_assignment' | 'other',
    notes: string | null,
    tenantId: string,
    actorUserId: string,
  ): Promise<void> {
    await pgAdmin.query('BEGIN');
    try {
      await pgAdmin.query(
        `UPDATE vehicle_ownerships
           SET ended_at = NOW(), transfer_reason = $2::"OwnershipTransferReason", transfer_notes = $3
         WHERE vehicle_id = $1 AND ended_at IS NULL`,
        [vehicleId, reason, notes],
      );
      await pgAdmin.query(
        `INSERT INTO vehicle_ownerships
           (id, vehicle_id, customer_id, started_at, transfer_reason, transfer_notes, created_at)
         VALUES (gen_random_uuid(), $1, $2, NOW(), $3::"OwnershipTransferReason", $4, NOW())`,
        [vehicleId, toCustomerId, reason, notes],
      );
      await pgAdmin.query(
        `INSERT INTO vehicle_transfers
           (id, vehicle_id, from_customer_id, to_customer_id, method, status,
            expires_at, completed_at, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3,
            'officina_mediated'::"TransferMethod",
            'completed'::"TransferStatus",
            NOW(), NOW(), NOW(), NOW())`,
        [vehicleId, fromCustomerId, toCustomerId],
      );
      await pgAdmin.query(
        `INSERT INTO access_logs
           (id, vehicle_id, tenant_id, user_id, action, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3,
            'ownership_transfer'::"AccessLogAction", NOW())`,
        [vehicleId, tenantId, actorUserId],
      );
      await pgAdmin.query('COMMIT');
    } catch (err) {
      await pgAdmin.query('ROLLBACK');
      throw err;
    }
  }

  it('performs atomic swap: closes old ownership and opens new', async () => {
    const { tenantId, locationId } = await createTenantWithLocation();
    const actor = await createUser({ tenantId, locationId });
    const cedente = await createCustomer({ tenantId });
    const cessionario = await createCustomer({ tenantId, email: `new-${Date.now()}@example.com` });
    const { vehicleId } = await createVehicle({ tenantId, status: 'certified' });
    await createVehicleOwnership({ vehicleId, customerId: cedente.id });

    await executeTransferSql(
      vehicleId,
      cedente.id,
      cessionario.id,
      'purchase',
      'Vendita usato',
      tenantId,
      actor.id,
    );

    const { rows } = await pgAdmin.query(
      `SELECT customer_id, started_at, ended_at, transfer_reason, transfer_notes
       FROM vehicle_ownerships WHERE vehicle_id = $1 ORDER BY started_at`,
      [vehicleId],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].customer_id).toBe(cedente.id);
    expect(rows[0].ended_at).not.toBeNull();
    expect(rows[0].transfer_reason).toBe('purchase');
    expect(rows[0].transfer_notes).toBe('Vendita usato');
    expect(rows[1].customer_id).toBe(cessionario.id);
    expect(rows[1].ended_at).toBeNull();
    expect(rows[1].transfer_reason).toBe('purchase');
  });

  it('BR-040: exactly one active ownership after transfer', async () => {
    const { tenantId, locationId } = await createTenantWithLocation();
    const actor = await createUser({ tenantId, locationId });
    const cedente = await createCustomer({ tenantId });
    const cessionario = await createCustomer({ tenantId, email: `new-${Date.now()}@example.com` });
    const { vehicleId } = await createVehicle({ tenantId, status: 'certified' });
    await createVehicleOwnership({ vehicleId, customerId: cedente.id });

    await executeTransferSql(
      vehicleId,
      cedente.id,
      cessionario.id,
      'other',
      null,
      tenantId,
      actor.id,
    );

    const { rows } = await pgAdmin.query(
      `SELECT COUNT(*)::int AS n FROM vehicle_ownerships
       WHERE vehicle_id = $1 AND ended_at IS NULL`,
      [vehicleId],
    );
    expect(rows[0].n).toBe(1);
  });

  it('writes VehicleTransfer audit row with method=officina_mediated, status=completed', async () => {
    const { tenantId, locationId } = await createTenantWithLocation();
    const actor = await createUser({ tenantId, locationId });
    const cedente = await createCustomer({ tenantId });
    const cessionario = await createCustomer({ tenantId, email: `new-${Date.now()}@example.com` });
    const { vehicleId } = await createVehicle({ tenantId, status: 'certified' });
    await createVehicleOwnership({ vehicleId, customerId: cedente.id });

    await executeTransferSql(
      vehicleId,
      cedente.id,
      cessionario.id,
      'inheritance',
      null,
      tenantId,
      actor.id,
    );

    const { rows } = await pgAdmin.query(
      `SELECT method, status, from_customer_id, to_customer_id, completed_at
       FROM vehicle_transfers WHERE vehicle_id = $1`,
      [vehicleId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].method).toBe('officina_mediated');
    expect(rows[0].status).toBe('completed');
    expect(rows[0].from_customer_id).toBe(cedente.id);
    expect(rows[0].to_customer_id).toBe(cessionario.id);
    expect(rows[0].completed_at).not.toBeNull();
  });

  it('writes AccessLog with action=ownership_transfer', async () => {
    const { tenantId, locationId } = await createTenantWithLocation();
    const actor = await createUser({ tenantId, locationId });
    const cedente = await createCustomer({ tenantId });
    const cessionario = await createCustomer({ tenantId, email: `new-${Date.now()}@example.com` });
    const { vehicleId } = await createVehicle({ tenantId, status: 'certified' });
    await createVehicleOwnership({ vehicleId, customerId: cedente.id });

    await executeTransferSql(
      vehicleId,
      cedente.id,
      cessionario.id,
      'company_assignment',
      null,
      tenantId,
      actor.id,
    );

    const { rows } = await pgAdmin.query(
      `SELECT action, vehicle_id FROM access_logs
       WHERE vehicle_id = $1 AND action = 'ownership_transfer'`,
      [vehicleId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('ownership_transfer');
    expect(rows[0].vehicle_id).toBe(vehicleId);
  });

  it('BR-047: rejects insert of second active VehicleTransfer on same vehicle', async () => {
    const { tenantId } = await createTenantWithLocation();
    const cedente = await createCustomer({ tenantId });
    const { vehicleId } = await createVehicle({ tenantId, status: 'certified' });
    await createVehicleOwnership({ vehicleId, customerId: cedente.id });

    await pgAdmin.query(
      `INSERT INTO vehicle_transfers
         (id, vehicle_id, transfer_code, method, status, expires_at, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'TRC-X-1',
          'initiated_by_seller'::"TransferMethod",
          'pending_recipient'::"TransferStatus",
          NOW() + INTERVAL '7 days', NOW(), NOW())`,
      [vehicleId],
    );

    await expect(
      pgAdmin.query(
        `INSERT INTO vehicle_transfers
           (id, vehicle_id, transfer_code, method, status, expires_at, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'TRC-X-2',
            'officina_mediated'::"TransferMethod",
            'pending_recipient'::"TransferStatus",
            NOW() + INTERVAL '7 days', NOW(), NOW())`,
        [vehicleId],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it('accepts officina_mediated enum value', async () => {
    const { tenantId } = await createTenantWithLocation();
    const { vehicleId } = await createVehicle({ tenantId, status: 'certified' });

    await expect(
      pgAdmin.query(
        `INSERT INTO vehicle_transfers
           (id, vehicle_id, method, status, expires_at, created_at, updated_at)
         VALUES (gen_random_uuid(), $1,
            'officina_mediated'::"TransferMethod",
            'completed'::"TransferStatus",
            NOW(), NOW(), NOW())`,
        [vehicleId],
      ),
    ).resolves.not.toThrow();
  });
});
