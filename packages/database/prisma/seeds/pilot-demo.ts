import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PrismaPg } from '@prisma/adapter-pg';

import { SYSTEM_INTERVENTION_TYPES } from '../../src/seed-data.js';
import { PrismaClient } from '../generated/prisma/client/client.js';

import { CUSTOMERS, INTERVENTIONS, TENANT, VEHICLES, personaEmail } from './pilot-demo-data.js';

interface RunOptions {
  pilotDemoSub: string;
  prisma?: PrismaClient;
}

function createClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'pilot-demo seed: DATABASE_URL is not set. Set it before running `pnpm seed:pilot-demo` (production: Supabase pooler URL).',
    );
  }
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter, log: ['error'] });
}

const MAX_GARAGE_CODE_ATTEMPTS = 3;
const PG_UNIQUE_VIOLATION = '23505';

async function certifyVehicle(
  prisma: PrismaClient,
  vehicleId: string,
  tenantId: string,
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_GARAGE_CODE_ATTEMPTS; attempt++) {
    const rows = await prisma.$queryRaw<
      Array<{ code: string }>
    >`SELECT generate_garage_code() AS code`;
    const candidate = rows[0]?.code;
    if (!candidate) throw new Error('generate_garage_code returned no rows');

    try {
      const affected = await prisma.$executeRaw`
        UPDATE vehicles
        SET garage_code = ${candidate},
            status = 'certified',
            certified_at = NOW(),
            certified_by_tenant_id = ${tenantId}::uuid
        WHERE id = ${vehicleId}::uuid AND garage_code IS NULL
      `;
      if (affected === 1) return;
      if (affected === 0) {
        // Concurrent writer or row missing — neither expected for a single-process seed.
        throw new Error(`certifyVehicle: 0 rows updated for vehicle ${vehicleId}`);
      }
      throw new Error(`certifyVehicle: unexpected affected count ${affected}`);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== PG_UNIQUE_VIOLATION) throw err;
      // unique_violation on garage_code → retry with a fresh candidate.
    }
  }
  throw new Error(
    `certifyVehicle: could not assign a unique garage_code after ${MAX_GARAGE_CODE_ATTEMPTS} attempts`,
  );
}

export async function runPilotDemoSeed(opts: RunOptions): Promise<void> {
  const prisma = opts.prisma ?? createClient();
  const ownClient = !opts.prisma;

  try {
    // 1. Tenant — upsert by vatNumber (unique).
    const tenant = await prisma.tenant.upsert({
      where: { vatNumber: TENANT.vatNumber },
      update: { businessName: TENANT.businessName, email: TENANT.email },
      create: {
        vatNumber: TENANT.vatNumber,
        businessName: TENANT.businessName,
        email: TENANT.email,
        plan: 'starter',
      },
    });

    // 2. Super-admin user bound to provided cognito sub.
    // Note: locationId removed as part of sede-unica migration — tenants no
    // longer have separate location rows; address lives directly on Tenant.
    await prisma.user.upsert({
      where: { cognitoSub: opts.pilotDemoSub },
      // email in update too so re-seeding with PILOT_DEMO_EMAIL_BASE set
      // applies the new alias (this row is keyed by the stable cognitoSub,
      // so update — not create — is the re-seed path).
      update: { tenantId: tenant.id, email: personaEmail('giuseppe') },
      create: {
        tenantId: tenant.id,
        cognitoSub: opts.pilotDemoSub,
        email: personaEmail('giuseppe'),
        firstName: 'Giuseppe',
        lastName: 'Bianchi',
        role: 'super_admin',
      },
    });

    // 4. Customers (unique by email) + customer_tenant_relation.
    const customerByEmail = new Map<string, string>();
    for (const c of CUSTOMERS) {
      const row = await prisma.customer.upsert({
        where: { email: c.email },
        update: { firstName: c.firstName, lastName: c.lastName },
        create: {
          email: c.email,
          firstName: c.firstName,
          lastName: c.lastName,
          phone: c.phone,
        },
      });
      customerByEmail.set(c.email, row.id);

      await prisma.customerTenantRelation.upsert({
        where: { tenantId_customerId: { tenantId: tenant.id, customerId: row.id } },
        update: {},
        create: { tenantId: tenant.id, customerId: row.id },
      });
    }

    // 5. Vehicles (unique by vin) + active VehicleOwnership.
    //
    // BR-003 (chk_certified_consistency): status='certified' implies
    // garage_code+certified_at+certified_by_tenant_id are all NOT NULL,
    // and chk_pending_consistency: status='pending' implies garage_code
    // IS NULL. So we cannot create the row directly as certified — we
    // upsert as pending, then atomically promote to certified with
    // generated garage_code, retrying on the (astronomically rare)
    // unique_violation. Mirrors api/lib/garage-code.ts:certifyVehicleWithGarageCode.
    const vehicleByVin = new Map<string, string>();
    for (const v of VEHICLES) {
      const ownerId = customerByEmail.get(v.ownerEmail);
      if (!ownerId) throw new Error(`Owner email ${v.ownerEmail} not found`);

      const vehicle = await prisma.vehicle.upsert({
        where: { vin: v.vin },
        update: {},
        create: {
          createdByTenantId: tenant.id,
          vin: v.vin,
          plate: v.plate,
          plateCountry: 'IT',
          make: v.make,
          model: v.model,
          version: v.version,
          year: v.year,
          fuelType: v.fuelType,
          vehicleType: v.vehicleType,
          registrationDate: v.registrationDate,
          status: 'pending',
        },
      });
      vehicleByVin.set(v.vin, vehicle.id);

      if (!vehicle.garageCode) {
        await certifyVehicle(prisma, vehicle.id, tenant.id);
      }

      // Active ownership — at most one open per vehicle. Idempotent via findFirst+create.
      const existingOwnership = await prisma.vehicleOwnership.findFirst({
        where: { vehicleId: vehicle.id, customerId: ownerId, endedAt: null },
      });
      if (!existingOwnership) {
        await prisma.vehicleOwnership.create({
          data: {
            vehicleId: vehicle.id,
            customerId: ownerId,
            startedAt: v.registrationDate,
          },
        });
      }
    }

    // 6. Lookup intervention type ids by code (system rows: tenantId NULL).
    const typeByCode = new Map<string, string>();
    for (const sysType of SYSTEM_INTERVENTION_TYPES) {
      const row = await prisma.interventionType.findFirst({
        where: { code: sysType.code, tenantId: null },
      });
      if (!row) {
        throw new Error(
          `System intervention type ${sysType.code} not seeded — run base seed (\`pnpm db:seed\`) first.`,
        );
      }
      typeByCode.set(sysType.code, row.id);
    }

    // 7. Resolve seeder user via cognitoSub.
    const seederUser = await prisma.user.findFirstOrThrow({
      where: { cognitoSub: opts.pilotDemoSub, tenantId: tenant.id },
    });

    // 8. Interventions — idempotent by triple (vehicleId, typeId, date).
    for (const i of INTERVENTIONS) {
      const vehicleId = vehicleByVin.get(i.vehicleVin);
      if (!vehicleId) throw new Error(`Vehicle ${i.vehicleVin} not seeded`);
      const typeId = typeByCode.get(i.interventionTypeCode);
      if (!typeId) throw new Error(`Type ${i.interventionTypeCode} not found`);
      const dateUtc = new Date(`${i.interventionDate}T00:00:00.000Z`);

      const existing = await prisma.intervention.findFirst({
        where: {
          vehicleId,
          interventionTypeId: typeId,
          interventionDate: dateUtc,
          tenantId: tenant.id,
        },
      });
      if (existing) continue;

      await prisma.intervention.create({
        data: {
          tenantId: tenant.id,
          userId: seederUser.id,
          vehicleId,
          interventionTypeId: typeId,
          interventionDate: dateUtc,
          odometerKm: i.odometerKm,
          title: i.title,
          description: i.description,
          partsReplaced: (i.partsReplaced ?? []) as unknown as object,
          status: 'active',
        },
      });
    }

    console.log(
      `[pilot-demo seed] OK — tenant ${tenant.businessName} (${tenant.vatNumber}), ${CUSTOMERS.length} customers, ${VEHICLES.length} vehicles, ${INTERVENTIONS.length} interventions`,
    );
  } finally {
    if (ownClient) await prisma.$disconnect();
  }
}

// CLI entrypoint — cross-platform main-module check (Windows-safe).
const invokedAsMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedAsMain) {
  const sub = process.env.PILOT_DEMO_SUB;
  if (!sub) {
    console.error(
      'PILOT_DEMO_SUB env var is required (cognito sub of seeded super_admin Giuseppe).',
    );
    process.exit(1);
  }
  runPilotDemoSeed({ pilotDemoSub: sub })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
