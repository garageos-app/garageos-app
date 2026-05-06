import { PrismaPg } from '@prisma/adapter-pg';

import { SYSTEM_INTERVENTION_TYPES } from '../../src/seed-data.js';
import { PrismaClient } from '../generated/prisma/client/client.js';

import { CUSTOMERS, INTERVENTIONS, LOCATION, TENANT, VEHICLES } from './pilot-demo-data.js';

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

    // 2. Location — no compound unique on (tenantId,name); findFirst+create.
    let location = await prisma.location.findFirst({
      where: { tenantId: tenant.id, name: LOCATION.name },
    });
    if (!location) {
      location = await prisma.location.create({
        data: {
          tenantId: tenant.id,
          name: LOCATION.name,
          addressLine: LOCATION.addressLine,
          city: LOCATION.city,
          province: LOCATION.province,
          postalCode: LOCATION.postalCode,
          country: LOCATION.country,
        },
      });
    }

    // 3. Super-admin user bound to provided cognito sub.
    await prisma.user.upsert({
      where: { cognitoSub: opts.pilotDemoSub },
      update: { tenantId: tenant.id, locationId: location.id },
      create: {
        tenantId: tenant.id,
        locationId: location.id,
        cognitoSub: opts.pilotDemoSub,
        email: 'giuseppe@demo-giuseppe.test',
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
    const vehicleByVin = new Map<string, string>();
    for (const v of VEHICLES) {
      const ownerId = customerByEmail.get(v.ownerEmail);
      if (!ownerId) throw new Error(`Owner email ${v.ownerEmail} not found`);

      const vehicle = await prisma.vehicle.upsert({
        where: { vin: v.vin },
        update: {},
        create: {
          createdByTenantId: tenant.id,
          certifiedByTenantId: tenant.id,
          certifiedAt: new Date(),
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
          status: 'certified',
        },
      });
      vehicleByVin.set(v.vin, vehicle.id);

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
          locationId: location.id,
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

// CLI entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
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
