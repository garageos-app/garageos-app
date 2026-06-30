import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { signTestToken } from '../helpers/jwt.js';
import { buildTestServer } from './fixtures.js';
import {
  createCustomer,
  createOwnership,
  createTenantWithLocation,
  createUser,
  createVehicle,
  resetDb,
} from './helpers.js';
import { pgAdmin } from './setup.js';

// PATCH /v1/vehicles/:id (F-OFF-106). Coverage:
// - happy path single + multi-field
// - BR-001 duplicate VIN, BR-002 duplicate plate (force + excludeId)
// - BR-005 VIN immutable on certified, allowed on pending
// - BR-007 year out-of-range, BR-008 archived blocked
// - BR-151 PII filter on currentOwnership
// - access_log action='update'
// - RLS-as-404 cross-tenant write
// - body strict / non-empty
// - updatedAt advances

describe('PATCH /v1/vehicles/:id (integration)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestServer();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb();
  });

  describe('happy path', () => {
    it('updates a single tech field and returns the refreshed vehicle', async () => {
      const { tenantId } = await createTenantWithLocation('patch-h1');
      const cognitoSub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01';
      await createUser({ tenantId, cognitoSub });
      const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

      const token = await signTestToken({
        pool: 'officine',
        sub: cognitoSub,
        tenantId,
        role: 'mechanic',
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/vehicles/${vehicleId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { color: 'blu metallizzato' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as { vehicle: { color: string } };
      expect(body.vehicle.color).toBe('blu metallizzato');

      const { rows } = await pgAdmin.query<{ color: string }>(
        `SELECT color FROM vehicles WHERE id = $1`,
        [vehicleId],
      );
      expect(rows[0]!.color).toBe('blu metallizzato');
    });

    it('updates multiple fields atomically and leaves others untouched', async () => {
      const { tenantId } = await createTenantWithLocation('patch-h2');
      const cognitoSub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02';
      await createUser({ tenantId, cognitoSub });
      const { vehicleId } = await createVehicle({
        createdByTenantId: tenantId,
        make: 'Fiat',
        model: 'Panda',
        year: 2020,
      });

      const token = await signTestToken({
        pool: 'officine',
        sub: cognitoSub,
        tenantId,
        role: 'mechanic',
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/vehicles/${vehicleId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          color: 'rosso',
          powerKw: 70,
          registrationDate: '2020-06-01',
        },
      });

      expect(res.statusCode).toBe(200);
      const { rows } = await pgAdmin.query<{
        color: string;
        power_kw: number;
        make: string;
        model: string;
        year: number;
        registration_date: string;
      }>(
        `SELECT color, power_kw, make, model, year,
                to_char(registration_date, 'YYYY-MM-DD') AS registration_date
         FROM vehicles WHERE id = $1`,
        [vehicleId],
      );
      expect(rows[0]!.color).toBe('rosso');
      expect(rows[0]!.power_kw).toBe(70);
      expect(rows[0]!.make).toBe('Fiat');
      expect(rows[0]!.model).toBe('Panda');
      expect(rows[0]!.year).toBe(2020);
      expect(rows[0]!.registration_date).toBe('2020-06-01');
    });
  });

  describe('BR-008 archived', () => {
    it('returns 422 vehicle.modification.archived when status=archived', async () => {
      const { tenantId } = await createTenantWithLocation('patch-arc');
      const cognitoSub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03';
      await createUser({ tenantId, cognitoSub });
      const { vehicleId } = await createVehicle({
        createdByTenantId: tenantId,
        status: 'archived',
      });

      const token = await signTestToken({
        pool: 'officine',
        sub: cognitoSub,
        tenantId,
        role: 'mechanic',
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/vehicles/${vehicleId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { color: 'rosso' },
      });

      expect(res.statusCode).toBe(422);
      const body = res.json() as { code: string };
      expect(body.code).toBe('vehicle.modification.archived');
    });
  });

  describe('BR-005 vin immutable on certified', () => {
    it('returns 422 vehicle.modification.vin_immutable when patching vin on certified', async () => {
      const { tenantId } = await createTenantWithLocation('patch-vin1');
      const cognitoSub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa04';
      await createUser({ tenantId, cognitoSub });
      const { vehicleId } = await createVehicle({
        createdByTenantId: tenantId,
        status: 'certified',
        vin: 'ZFA12300000001AAA',
      });

      const token = await signTestToken({
        pool: 'officine',
        sub: cognitoSub,
        tenantId,
        role: 'mechanic',
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/vehicles/${vehicleId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { vin: 'ZFA99900000001ZZZ', forceNonstandardVin: true },
      });

      expect(res.statusCode).toBe(422);
      const body = res.json() as { code: string };
      expect(body.code).toBe('vehicle.modification.vin_immutable');
    });

    it('allows VIN change on pending vehicles', async () => {
      const { tenantId } = await createTenantWithLocation('patch-vin2');
      const cognitoSub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa05';
      await createUser({ tenantId, cognitoSub });
      const { vehicleId } = await createVehicle({
        createdByTenantId: tenantId,
        status: 'pending',
        vin: 'ZFA12300000002AAA',
      });

      const token = await signTestToken({
        pool: 'officine',
        sub: cognitoSub,
        tenantId,
        role: 'mechanic',
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/vehicles/${vehicleId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { vin: 'ZFA99900000002ZZZ', forceNonstandardVin: true },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as { vehicle: { vin: string } };
      expect(body.vehicle.vin).toBe('ZFA99900000002ZZZ');
    });

    it('returns 200 when vin in body equals current vin (no-op)', async () => {
      const { tenantId } = await createTenantWithLocation('patch-vin3');
      const cognitoSub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa06';
      await createUser({ tenantId, cognitoSub });
      const { vehicleId, vin } = await createVehicle({
        createdByTenantId: tenantId,
        status: 'certified',
      });

      const token = await signTestToken({
        pool: 'officine',
        sub: cognitoSub,
        tenantId,
        role: 'mechanic',
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/vehicles/${vehicleId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { vin, forceNonstandardVin: true, color: 'verde' },
      });

      expect(res.statusCode).toBe(200);
    });
  });

  describe('VIN change validation', () => {
    it('returns 400 invalid_vin_checksum when new VIN fails ISO 3779 and forceNonstandardVin=false', async () => {
      const { tenantId } = await createTenantWithLocation('patch-cks');
      const cognitoSub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa07';
      await createUser({ tenantId, cognitoSub });
      const { vehicleId } = await createVehicle({
        createdByTenantId: tenantId,
        status: 'pending',
      });

      const token = await signTestToken({
        pool: 'officine',
        sub: cognitoSub,
        tenantId,
        role: 'mechanic',
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/vehicles/${vehicleId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { vin: 'AAAAAAAAAAAAAAAAA' },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json() as { code: string };
      expect(body.code).toBe('vehicle.creation.invalid_vin_checksum');
    });

    it('accepts non-3779 VIN when forceNonstandardVin=true', async () => {
      const { tenantId } = await createTenantWithLocation('patch-cks2');
      const cognitoSub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa08';
      await createUser({ tenantId, cognitoSub });
      const { vehicleId } = await createVehicle({
        createdByTenantId: tenantId,
        status: 'pending',
      });

      const token = await signTestToken({
        pool: 'officine',
        sub: cognitoSub,
        tenantId,
        role: 'mechanic',
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/vehicles/${vehicleId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { vin: 'AAAAAAAAAAAAAAAAA', forceNonstandardVin: true },
      });

      expect(res.statusCode).toBe(200);
    });

    it('returns 409 duplicate_vin when new VIN exists on another vehicle', async () => {
      const { tenantId } = await createTenantWithLocation('patch-dup');
      const cognitoSub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa09';
      await createUser({ tenantId, cognitoSub });
      await createVehicle({
        createdByTenantId: tenantId,
        vin: 'ZFA11100000003BBB',
      });
      const { vehicleId } = await createVehicle({
        createdByTenantId: tenantId,
        status: 'pending',
      });

      const token = await signTestToken({
        pool: 'officine',
        sub: cognitoSub,
        tenantId,
        role: 'mechanic',
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/vehicles/${vehicleId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { vin: 'ZFA11100000003BBB', forceNonstandardVin: true },
      });

      expect(res.statusCode).toBe(409);
      const body = res.json() as { code: string };
      expect(body.code).toBe('vehicle.creation.duplicate_vin');
    });
  });

  describe('Plate change validation', () => {
    it('returns 409 duplicate_plate_warning when new plate already used and force=false', async () => {
      const { tenantId } = await createTenantWithLocation('patch-pl1');
      const cognitoSub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa10';
      await createUser({ tenantId, cognitoSub });
      await createVehicle({ createdByTenantId: tenantId, plate: 'AB123CD' });
      const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

      const token = await signTestToken({
        pool: 'officine',
        sub: cognitoSub,
        tenantId,
        role: 'mechanic',
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/vehicles/${vehicleId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { plate: 'AB123CD' },
      });

      expect(res.statusCode).toBe(409);
      const body = res.json() as { code: string };
      expect(body.code).toBe('vehicle.creation.duplicate_plate_warning');
    });

    it('accepts duplicate plate when force=true', async () => {
      const { tenantId } = await createTenantWithLocation('patch-pl2');
      const cognitoSub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa11';
      await createUser({ tenantId, cognitoSub });
      await createVehicle({ createdByTenantId: tenantId, plate: 'AB123CE' });
      const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

      const token = await signTestToken({
        pool: 'officine',
        sub: cognitoSub,
        tenantId,
        role: 'mechanic',
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/vehicles/${vehicleId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { plate: 'AB123CE', force: true },
      });

      expect(res.statusCode).toBe(200);
    });

    it('returns 200 when plate sent is unchanged (excludeId prevents self-collision)', async () => {
      const { tenantId } = await createTenantWithLocation('patch-pl3');
      const cognitoSub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa12';
      await createUser({ tenantId, cognitoSub });
      // Explicit valid Italian plate so the PATCH body passes ItalianPlateSchema
      // when the test re-sends the same value (the random helper plate uses
      // 5 digits which would not pass strict validation here).
      const { vehicleId } = await createVehicle({
        createdByTenantId: tenantId,
        plate: 'AB123CF',
      });

      const token = await signTestToken({
        pool: 'officine',
        sub: cognitoSub,
        tenantId,
        role: 'mechanic',
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/vehicles/${vehicleId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { plate: 'AB123CF', color: 'arancio' },
      });

      expect(res.statusCode).toBe(200);
    });
  });

  describe('BR-151 PII filter', () => {
    it('masks owner PII when tenant has no customer_tenant_relation', async () => {
      const { tenantId } = await createTenantWithLocation('patch-pii');
      const cognitoSub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa13';
      await createUser({ tenantId, cognitoSub });
      const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });
      const { customerId } = await createCustomer({});
      await createOwnership({ vehicleId, customerId });
      // No createCustomerTenantRelation → BR-151 must mask.

      const token = await signTestToken({
        pool: 'officine',
        sub: cognitoSub,
        tenantId,
        role: 'mechanic',
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/vehicles/${vehicleId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { color: 'nero' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        currentOwnership: {
          customer: { redacted: boolean; displayName?: string; firstName?: string };
        } | null;
      };
      expect(body.currentOwnership).not.toBeNull();
      expect(body.currentOwnership!.customer.redacted).toBe(true);
      expect(body.currentOwnership!.customer.displayName).toBe('Proprietario non in anagrafica');
      expect(body.currentOwnership!.customer.firstName).toBeUndefined();
    });
  });

  describe('access_log', () => {
    it('writes a row with action=update and the right user/tenant/ip', async () => {
      const { tenantId } = await createTenantWithLocation('patch-log');
      const cognitoSub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa14';
      const { userId } = await createUser({ tenantId, cognitoSub });
      const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

      const token = await signTestToken({
        pool: 'officine',
        sub: cognitoSub,
        tenantId,
        role: 'mechanic',
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/vehicles/${vehicleId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { color: 'oro' },
      });

      expect(res.statusCode).toBe(200);

      const { rows } = await pgAdmin.query<{
        action: string;
        tenant_id: string;
        user_id: string;
        ip_address: string | null;
      }>(
        `SELECT action, tenant_id, user_id, ip_address::text
         FROM access_logs WHERE vehicle_id = $1`,
        [vehicleId],
      );
      const updateLogs = rows.filter((r) => r.action === 'update');
      expect(updateLogs).toHaveLength(1);
      expect(updateLogs[0]!.tenant_id).toBe(tenantId);
      expect(updateLogs[0]!.user_id).toBe(userId);
      expect(updateLogs[0]!.ip_address).not.toBeNull();
    });
  });

  describe('RLS cross-tenant', () => {
    it('returns 404 when patching tenant is neither created_by nor certified_by', async () => {
      const { tenantId: tenantA } = await createTenantWithLocation('patch-rls-a');
      const { vehicleId } = await createVehicle({ createdByTenantId: tenantA });

      const { tenantId: tenantB } = await createTenantWithLocation('patch-rls-b');
      const cognitoSub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa15';
      await createUser({ tenantId: tenantB, cognitoSub });

      const token = await signTestToken({
        pool: 'officine',
        sub: cognitoSub,
        tenantId: tenantB,
        role: 'mechanic',
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/vehicles/${vehicleId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { color: 'forbidden' },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('body validation surface', () => {
    async function patchWithBody(payload: Record<string, unknown>) {
      const { tenantId } = await createTenantWithLocation('patch-bv');
      const cognitoSub = `aaaaaaaa-aaaa-4aaa-8aaa-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`;
      await createUser({ tenantId, cognitoSub });
      const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

      const token = await signTestToken({
        pool: 'officine',
        sub: cognitoSub,
        tenantId,
        role: 'mechanic',
      });

      return await app.inject({
        method: 'PATCH',
        url: `/v1/vehicles/${vehicleId}`,
        headers: { authorization: `Bearer ${token}` },
        payload,
      });
    }

    it('returns 400 when year is out of range BR-007', async () => {
      const res = await patchWithBody({ year: 1800 });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when body contains an unknown field (e.g. status)', async () => {
      const res = await patchWithBody({ status: 'archived' });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when body has no editable field', async () => {
      const res = await patchWithBody({});
      expect(res.statusCode).toBe(400);
    });
  });

  describe('updatedAt', () => {
    it('advances updatedAt after a PATCH', async () => {
      const { tenantId } = await createTenantWithLocation('patch-upd');
      const cognitoSub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa16';
      await createUser({ tenantId, cognitoSub });
      const { vehicleId } = await createVehicle({ createdByTenantId: tenantId });

      const before = await pgAdmin.query<{ updated_at: Date }>(
        `SELECT updated_at FROM vehicles WHERE id = $1`,
        [vehicleId],
      );
      await new Promise((r) => setTimeout(r, 5));

      const token = await signTestToken({
        pool: 'officine',
        sub: cognitoSub,
        tenantId,
        role: 'mechanic',
      });
      await app.inject({
        method: 'PATCH',
        url: `/v1/vehicles/${vehicleId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { color: 'cremisi' },
      });

      const after = await pgAdmin.query<{ updated_at: Date }>(
        `SELECT updated_at FROM vehicles WHERE id = $1`,
        [vehicleId],
      );
      expect(after.rows[0]!.updated_at.getTime()).toBeGreaterThan(
        before.rows[0]!.updated_at.getTime(),
      );
    });
  });
});
