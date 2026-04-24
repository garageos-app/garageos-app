import { PrismaPg } from '@prisma/adapter-pg';

import { SYSTEM_INTERVENTION_TYPES } from '../src/seed-data.js';

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

async function main(): Promise<void> {
  const prisma = createClient();
  try {
    console.log('[seed] starting...');
    const count = await seedInterventionTypes(prisma);
    console.log(`[seed] upserted ${count} system intervention types`);
    console.log('[seed] done');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
