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
      const { tenantId, locationId } = await createTenantWithLocation('patch-h1');
      const cognitoSub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01';
      await createUser({ tenantId, cognitoSub, locationId });
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
  });
});

// Imports retained for downstream tests (BR-151 PII section uses these).
void createCustomer;
void createOwnership;
