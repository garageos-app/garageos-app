import { randomUUID } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import { createTenantWithLocation, getSystemInterventionTypeId, resetDb } from './helpers.js';
import { pgAdmin } from './setup.js';

describe('CHECK constraints and partial unique indexes', () => {
  beforeEach(async () => {
    await resetDb();
  });

  describe('BR-020 garage_code format', () => {
    it('rejects a vehicle with malformed garage_code', async () => {
      const { tenantId } = await createTenantWithLocation();

      // Length 11 fits VARCHAR(12); the format is invalid because
      // NNN contains 0/1 (BR-020 forbids). status='certified' plus
      // the certification columns keep chk_certified_consistency
      // satisfied so the failure isolates garage_code format.
      await expect(
        pgAdmin.query(
          `INSERT INTO vehicles
             (id, garage_code, vin, plate, make, model, year, vehicle_type, fuel_type,
              status, certified_by_tenant_id, certified_at, created_at, updated_at)
           VALUES
             (gen_random_uuid(), 'GO-012-ABCD', 'VIN00000000000001',
              'AA111BB', 'Fiat', 'Panda', 2020, 'car'::"VehicleType",
              'petrol'::"FuelType", 'certified'::"VehicleStatus", $1, NOW(), NOW(), NOW())`,
          [tenantId],
        ),
      ).rejects.toThrow(/chk_garage_code_format/);
    });

    // Regression for the alphabet drift fixed in migration
    // 20260425100000_fix_generate_garage_code_alphabet. Pre-fix the
    // function alphabet contained 'S' while the CHECK constraint
    // forbade it; ~17% of generated codes failed the constraint at
    // INSERT time. 200 iterations leaves the no-S probability at
    // (21/22)^800 ≈ 1.6e-16 — for practical purposes a hard guarantee
    // that any S-leak would surface here.
    it('every code from generate_garage_code() satisfies the CHECK regex', async () => {
      for (let i = 0; i < 200; i++) {
        const { rows } = await pgAdmin.query<{ code: string }>(
          `SELECT generate_garage_code() AS code`,
        );
        expect(rows[0]!.code).toMatch(/^GO-[2-9]{3}-[A-HJ-NPRTV-Z]{4}$/);
      }
    });
  });

  describe('BR-007 vehicle year range', () => {
    it('rejects a vehicle with year below 1900', async () => {
      const { tenantId } = await createTenantWithLocation();

      await expect(
        pgAdmin.query(
          `INSERT INTO vehicles
             (id, vin, plate, make, model, year, vehicle_type, fuel_type, status,
              created_by_tenant_id, created_at, updated_at)
           VALUES
             (gen_random_uuid(), 'VIN00000000000002', 'AA222BB', 'Fiat', 'Panda',
              1899, 'car'::"VehicleType", 'petrol'::"FuelType",
              'pending'::"VehicleStatus", $1, NOW(), NOW())`,
          [tenantId],
        ),
      ).rejects.toThrow(/chk_year_range/);
    });
  });

  describe('BR-100 deadline needs at least one criterion', () => {
    it('rejects a deadline with neither due_date nor due_odometer_km', async () => {
      const { tenantId, locationId } = await createTenantWithLocation();
      const { rows: vehicleRows } = await pgAdmin.query<{ id: string }>(
        `INSERT INTO vehicles
           (id, vin, plate, make, model, year, vehicle_type, fuel_type, status,
            created_by_tenant_id, created_at, updated_at)
         VALUES
           (gen_random_uuid(), 'VIN00000000000003', 'AA333BB', 'Fiat', 'Panda',
            2020, 'car'::"VehicleType", 'petrol'::"FuelType",
            'pending'::"VehicleStatus", $1, NOW(), NOW())
         RETURNING id`,
        [tenantId],
      );
      const vehicleId = vehicleRows[0]!.id;
      const interventionTypeId = await getSystemInterventionTypeId();

      await expect(
        pgAdmin.query(
          `INSERT INTO deadlines
             (id, tenant_id, location_id, vehicle_id, intervention_type_id,
              status, is_recurring, created_at, updated_at)
           VALUES
             (gen_random_uuid(), $1, $2, $3, $4, 'open'::"DeadlineStatus",
              false, NOW(), NOW())`,
          [tenantId, locationId, vehicleId, interventionTypeId],
        ),
      ).rejects.toThrow(/chk_deadline_has_criterion/);
    });
  });

  describe('BR-180 attachment size limit', () => {
    it('rejects an attachment larger than 10 MB', async () => {
      const { tenantId } = await createTenantWithLocation();

      await expect(
        pgAdmin.query(
          `INSERT INTO attachments
             (id, owner_type, owner_id, tenant_id, file_name, mime_type,
              size_bytes, s3_key, s3_bucket, created_at)
           VALUES
             (gen_random_uuid(), 'intervention'::"AttachmentOwnerType",
              gen_random_uuid(), $1, 'huge.pdf', 'application/pdf',
              20000000, 'some/key', 'bucket', NOW())`,
          [tenantId],
        ),
      ).rejects.toThrow(/chk_attachment_size/);
    });
  });

  describe('BR-040 single active ownership per vehicle', () => {
    async function setupVehicleAndOwners() {
      const { tenantId } = await createTenantWithLocation();
      const { rows: vRows } = await pgAdmin.query<{ id: string }>(
        `INSERT INTO vehicles
           (id, vin, plate, make, model, year, vehicle_type, fuel_type, status,
            created_by_tenant_id, created_at, updated_at)
         VALUES
           (gen_random_uuid(), 'VIN00000000000004', 'AA444BB', 'Fiat', 'Panda',
            2020, 'car'::"VehicleType", 'petrol'::"FuelType",
            'pending'::"VehicleStatus", $1, NOW(), NOW())
         RETURNING id`,
        [tenantId],
      );
      const { rows: c1 } = await pgAdmin.query<{ id: string }>(
        `INSERT INTO customers (id, email, first_name, last_name, created_at, updated_at)
         VALUES (gen_random_uuid(), 'owner1@test.it', 'Mario', 'Rossi', NOW(), NOW())
         RETURNING id`,
      );
      const { rows: c2 } = await pgAdmin.query<{ id: string }>(
        `INSERT INTO customers (id, email, first_name, last_name, created_at, updated_at)
         VALUES (gen_random_uuid(), 'owner2@test.it', 'Luigi', 'Bianchi', NOW(), NOW())
         RETURNING id`,
      );
      return { vehicleId: vRows[0]!.id, owner1Id: c1[0]!.id, owner2Id: c2[0]!.id };
    }

    it('rejects a second active ownership via the partial unique index', async () => {
      const { vehicleId, owner1Id, owner2Id } = await setupVehicleAndOwners();

      await pgAdmin.query(
        `INSERT INTO vehicle_ownerships (id, vehicle_id, customer_id, started_at, created_at)
         VALUES (gen_random_uuid(), $1, $2, NOW(), NOW())`,
        [vehicleId, owner1Id],
      );

      // PG reports partial unique index violations with the class of
      // error; the exact index name varies by driver. Match on the
      // error class.
      await expect(
        pgAdmin.query(
          `INSERT INTO vehicle_ownerships (id, vehicle_id, customer_id, started_at, created_at)
           VALUES (gen_random_uuid(), $1, $2, NOW(), NOW())`,
          [vehicleId, owner2Id],
        ),
      ).rejects.toThrow(/duplicate key|unique/i);
    });

    it('allows a new active ownership after the previous one has ended', async () => {
      const { vehicleId, owner1Id, owner2Id } = await setupVehicleAndOwners();

      await pgAdmin.query(
        `INSERT INTO vehicle_ownerships (id, vehicle_id, customer_id, started_at, ended_at, created_at)
         VALUES (gen_random_uuid(), $1, $2, '2024-01-01', '2025-01-01', NOW())`,
        [vehicleId, owner1Id],
      );

      const { rows } = await pgAdmin.query<{ id: string }>(
        `INSERT INTO vehicle_ownerships (id, vehicle_id, customer_id, started_at, created_at)
         VALUES (gen_random_uuid(), $1, $2, NOW(), NOW())
         RETURNING id`,
        [vehicleId, owner2Id],
      );
      expect(rows[0]!.id).toBeDefined();
    });
  });

  describe('chk_attachment_owner_consistent — intervention_dispute branch', () => {
    // Helper: create a customer (without tenant relation, just a bare customer row).
    async function createBareCustomer(): Promise<string> {
      const { rows } = await pgAdmin.query<{ id: string }>(
        `INSERT INTO customers (id, email, first_name, last_name, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'Mario', 'Rossi', NOW(), NOW())
         RETURNING id`,
        [`customer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`],
      );
      return rows[0]!.id;
    }

    // Helper: create a user under tenantId (super_admin role).
    async function createUserForTenant(tenantId: string, locationId: string): Promise<string> {
      const { rows } = await pgAdmin.query<{ id: string }>(
        `INSERT INTO users
           (id, tenant_id, location_id, cognito_sub, email, role,
            first_name, last_name, status, created_at, updated_at)
         VALUES
           (gen_random_uuid(), $1, $2, $3, $4, 'super_admin'::"UserRole",
            'Test', 'User', 'active'::"UserStatus", NOW(), NOW())
         RETURNING id`,
        [
          tenantId,
          locationId,
          `cog-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`,
        ],
      );
      return rows[0]!.id;
    }

    it('accepts customer-uploaded dispute attachment (customer_id set, tenant_id set, uploaded_by_customer_id set)', async () => {
      const { tenantId } = await createTenantWithLocation();
      const customerId = await createBareCustomer();
      const interventionId = randomUUID();

      await expect(
        pgAdmin.query(
          `INSERT INTO attachments
             (id, owner_type, owner_id, tenant_id, customer_id,
              uploaded_by_customer_id, file_name, mime_type, size_bytes,
              s3_key, s3_bucket, created_at)
           VALUES
             (gen_random_uuid(), 'intervention_dispute'::"AttachmentOwnerType",
              $1, $2, $3, $3, 'foto.jpg', 'image/jpeg', 1024,
              'attachments/intervention_dispute/' || $1::text || '/x.jpg', 'test', NOW())`,
          [interventionId, tenantId, customerId],
        ),
      ).resolves.not.toThrow();
    });

    it('accepts officina-uploaded dispute attachment (customer_id NULL, tenant_id set, uploaded_by_user_id set)', async () => {
      const { tenantId, locationId } = await createTenantWithLocation();
      const userId = await createUserForTenant(tenantId, locationId);
      const interventionId = randomUUID();

      await expect(
        pgAdmin.query(
          `INSERT INTO attachments
             (id, owner_type, owner_id, tenant_id,
              uploaded_by_user_id, file_name, mime_type, size_bytes,
              s3_key, s3_bucket, created_at)
           VALUES
             (gen_random_uuid(), 'intervention_dispute'::"AttachmentOwnerType",
              $1, $2, $3, 'foto.jpg', 'image/jpeg', 1024,
              'attachments/intervention_dispute/' || $1::text || '/x.jpg', 'test', NOW())`,
          [interventionId, tenantId, userId],
        ),
      ).resolves.not.toThrow();
    });

    it('rejects intervention_dispute with both uploader columns set', async () => {
      const { tenantId, locationId } = await createTenantWithLocation();
      const userId = await createUserForTenant(tenantId, locationId);
      const customerId = await createBareCustomer();
      const interventionId = randomUUID();

      await expect(
        pgAdmin.query(
          `INSERT INTO attachments
             (id, owner_type, owner_id, tenant_id, customer_id,
              uploaded_by_user_id, uploaded_by_customer_id,
              file_name, mime_type, size_bytes, s3_key, s3_bucket, created_at)
           VALUES
             (gen_random_uuid(), 'intervention_dispute'::"AttachmentOwnerType",
              $1, $2, $3, $4, $3, 'foto.jpg', 'image/jpeg', 1024,
              'k', 'b', NOW())`,
          [interventionId, tenantId, customerId, userId],
        ),
      ).rejects.toThrow(/chk_attachment_owner_consistent/);
    });

    it('rejects intervention_dispute customer-uploaded with customer_id NULL', async () => {
      const { tenantId } = await createTenantWithLocation();
      const customerId = await createBareCustomer();
      const interventionId = randomUUID();

      await expect(
        pgAdmin.query(
          `INSERT INTO attachments
             (id, owner_type, owner_id, tenant_id,
              uploaded_by_customer_id, file_name, mime_type, size_bytes,
              s3_key, s3_bucket, created_at)
           VALUES
             (gen_random_uuid(), 'intervention_dispute'::"AttachmentOwnerType",
              $1, $2, $3, 'foto.jpg', 'image/jpeg', 1024,
              'k', 'b', NOW())`,
          [interventionId, tenantId, customerId],
        ),
      ).rejects.toThrow(/chk_attachment_owner_consistent/);
    });

    it('rejects intervention_dispute officina-uploaded with customer_id set', async () => {
      const { tenantId, locationId } = await createTenantWithLocation();
      const userId = await createUserForTenant(tenantId, locationId);
      const customerId = await createBareCustomer();
      const interventionId = randomUUID();

      await expect(
        pgAdmin.query(
          `INSERT INTO attachments
             (id, owner_type, owner_id, tenant_id, customer_id,
              uploaded_by_user_id, file_name, mime_type, size_bytes,
              s3_key, s3_bucket, created_at)
           VALUES
             (gen_random_uuid(), 'intervention_dispute'::"AttachmentOwnerType",
              $1, $2, $3, $4, 'foto.jpg', 'image/jpeg', 1024,
              'k', 'b', NOW())`,
          [interventionId, tenantId, customerId, userId],
        ),
      ).rejects.toThrow(/chk_attachment_owner_consistent/);
    });

    it('rejects intervention_dispute with tenant_id NULL', async () => {
      const customerId = await createBareCustomer();
      const interventionId = randomUUID();

      await expect(
        pgAdmin.query(
          `INSERT INTO attachments
             (id, owner_type, owner_id, customer_id,
              uploaded_by_customer_id, file_name, mime_type, size_bytes,
              s3_key, s3_bucket, created_at)
           VALUES
             (gen_random_uuid(), 'intervention_dispute'::"AttachmentOwnerType",
              $1, $2, $2, 'foto.jpg', 'image/jpeg', 1024, 'k', 'b', NOW())`,
          [interventionId, customerId],
        ),
      ).rejects.toThrow(/chk_attachment_owner_consistent/);
    });
  });
});
