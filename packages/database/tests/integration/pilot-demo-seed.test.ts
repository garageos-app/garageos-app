import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../../prisma/generated/prisma/client/client.js';
import { runPilotDemoSeed } from '../../prisma/seeds/pilot-demo.js';

import { pgAdmin } from './setup.js';

const TEST_SUB = '11111111-1111-4111-8111-111111111111';

describe('pilot-demo seed (idempotency)', () => {
  let adminPrisma: PrismaClient;

  beforeAll(() => {
    const adminUrl = process.env.ADMIN_DATABASE_URL;
    if (!adminUrl) throw new Error('ADMIN_DATABASE_URL not set by globalSetup');
    adminPrisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: adminUrl }),
      log: ['error'],
    });
  });

  afterAll(async () => {
    await adminPrisma.$disconnect();
  });

  beforeEach(async () => {
    // Reset pilot data; system intervention types stay seeded by globalSetup.
    await pgAdmin.query(
      `DELETE FROM vehicle_ownerships WHERE vehicle_id IN (SELECT id FROM vehicles WHERE vin LIKE 'VINDEMO%')`,
    );
    await pgAdmin.query(
      `DELETE FROM interventions WHERE tenant_id IN (SELECT id FROM tenants WHERE vat_number = 'IT00000000000')`,
    );
    await pgAdmin.query(
      `DELETE FROM customer_tenant_relations WHERE tenant_id IN (SELECT id FROM tenants WHERE vat_number = 'IT00000000000')`,
    );
    await pgAdmin.query(
      `DELETE FROM users WHERE tenant_id IN (SELECT id FROM tenants WHERE vat_number = 'IT00000000000')`,
    );
    await pgAdmin.query(`DELETE FROM vehicles WHERE vin LIKE 'VINDEMO%'`);
    await pgAdmin.query(`DELETE FROM customers WHERE email LIKE '%@demo-giuseppe.test'`);
    await pgAdmin.query(`DELETE FROM tenants WHERE vat_number = 'IT00000000000'`);
  });

  it('runs successfully twice with identical counts', async () => {
    await runPilotDemoSeed({ pilotDemoSub: TEST_SUB, prisma: adminPrisma });

    const counts1 = await fetchCounts();
    expect(counts1.tenants).toBe(1);
    expect(counts1.vehicles).toBe(5);
    expect(counts1.customers).toBe(3);
    expect(counts1.interventions).toBe(20);

    // Re-run on populated DB; idempotent via deterministic keys.
    await runPilotDemoSeed({ pilotDemoSub: TEST_SUB, prisma: adminPrisma });
    const counts2 = await fetchCounts();
    expect(counts2).toEqual(counts1);
  });
});

async function fetchCounts(): Promise<{
  tenants: number;
  vehicles: number;
  customers: number;
  interventions: number;
}> {
  const tenants = await pgAdmin.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM tenants WHERE vat_number='IT00000000000'`,
  );
  const vehicles = await pgAdmin.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM vehicles
     WHERE certified_by_tenant_id = (SELECT id FROM tenants WHERE vat_number='IT00000000000')`,
  );
  const customers = await pgAdmin.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM customers WHERE email LIKE '%@demo-giuseppe.test'`,
  );
  const interventions = await pgAdmin.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM interventions
     WHERE tenant_id = (SELECT id FROM tenants WHERE vat_number='IT00000000000')`,
  );
  return {
    tenants: tenants.rows[0].count,
    vehicles: vehicles.rows[0].count,
    customers: customers.rows[0].count,
    interventions: interventions.rows[0].count,
  };
}
