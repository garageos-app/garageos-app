import { PrismaPg } from '@prisma/adapter-pg';

import { SYSTEM_INTERVENTION_TYPES, SYSTEM_CHECKLIST_ITEMS } from '../src/seed-data.js';

import { PrismaClient } from './generated/prisma/client/client.js';

function createClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'prisma/seed.ts: DATABASE_URL is not set. Set it before running `pnpm db:seed` (locally: .env.local; CI: Testcontainers setup).',
    );
  }
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter, log: ['error'] });
}

async function seedInterventionTypes(prisma: PrismaClient): Promise<number> {
  // Idempotent upsert by (tenant_id=NULL, code). We avoid the Prisma
  // compound-unique where clause because its generated TS type forbids
  // `tenantId: null`; findFirst + update/create sidesteps that and is
  // equivalent at read+write cost (2 queries per row on first run).
  let written = 0;
  for (const type of SYSTEM_INTERVENTION_TYPES) {
    const existing = await prisma.interventionType.findFirst({
      where: { tenantId: null, code: type.code },
    });

    if (existing) {
      await prisma.interventionType.update({
        where: { id: existing.id },
        data: type,
      });
    } else {
      await prisma.interventionType.create({
        data: { ...type, tenantId: null },
      });
    }
    written += 1;
  }
  return written;
}

async function seedChecklistItems(prisma: PrismaClient): Promise<number> {
  // Idempotent upsert by (intervention_type_id, code), same pattern as
  // seedInterventionTypes above. Must run after intervention types are
  // seeded, since each item is resolved against its parent type by code.
  let written = 0;
  for (const item of SYSTEM_CHECKLIST_ITEMS) {
    const type = await prisma.interventionType.findFirst({
      where: { tenantId: null, code: item.typeCode },
      select: { id: true },
    });
    if (!type) throw new Error(`seed: intervention type ${item.typeCode} not found`);

    const existing = await prisma.interventionChecklistItem.findFirst({
      where: { interventionTypeId: type.id, code: item.code },
      select: { id: true },
    });
    if (existing) {
      await prisma.interventionChecklistItem.update({
        where: { id: existing.id },
        data: { nameIt: item.nameIt, sortOrder: item.sortOrder, active: true },
      });
    } else {
      await prisma.interventionChecklistItem.create({
        data: {
          interventionTypeId: type.id,
          code: item.code,
          nameIt: item.nameIt,
          sortOrder: item.sortOrder,
        },
      });
    }
    written += 1;
  }
  return written;
}

async function main(): Promise<void> {
  const prisma = createClient();
  try {
    console.log('[seed] starting...');
    const typeCount = await seedInterventionTypes(prisma);
    console.log(`[seed] upserted ${typeCount} system intervention types`);
    const itemCount = await seedChecklistItems(prisma);
    console.log(`[seed] upserted ${itemCount} system checklist items`);
    console.log('[seed] done');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
