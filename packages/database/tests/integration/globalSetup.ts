import { execSync } from 'node:child_process';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

// APPENDICE_E §5.2 pins postgres:15-alpine. Supabase runs newer in
// production, but PostgreSQL is backward-compatible for our feature set.
// Bumping is a dedicated PR if an incompatibility ever surfaces.
const POSTGRES_IMAGE = 'postgres:15-alpine';

// Non-superuser role used by Prisma during the test run. Required
// because BYPASSRLS is granted automatically to any superuser, and
// FORCE ROW LEVEL SECURITY does not cover superusers — it only covers
// table owners. Without a non-super connection our RLS policies would
// be invisible to the test DB traffic.
const APP_ROLE = 'app_test';
const APP_PASSWORD = 'app';

let container: StartedPostgreSqlContainer | null = null;

export async function setup(): Promise<void> {
  container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase('garageos_test')
    .withUsername('test')
    .withPassword('test')
    .start();

  const superUrl = container.getConnectionUri();

  // Apply migrations and seed using the superuser connection.
  process.env.DATABASE_URL = superUrl;
  process.env.DIRECT_URL = superUrl;
  execSync('pnpm prisma migrate deploy', { stdio: 'inherit' });
  execSync('pnpm db:seed', { stdio: 'inherit' });

  // Create the non-superuser role, hand it read/write + execute
  // privileges on the existing schema. Done via pg directly because
  // these are one-shot DCL statements outside the migration timeline.
  const superClient = new pg.Client({ connectionString: superUrl });
  await superClient.connect();
  try {
    await superClient.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);
    await superClient.query(
      `CREATE ROLE ${APP_ROLE} WITH LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS`,
    );
    await superClient.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
    await superClient.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`);
    await superClient.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}`);
    await superClient.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${APP_ROLE}`);
  } finally {
    await superClient.end();
  }

  // Two URLs are handed to the worker:
  //   - DATABASE_URL → non-super role `app_test`, subject to RLS. This
  //     is what the `prisma` singleton imports from src/client.ts
  //     connects with; tests use it for the assertions that verify
  //     policies actually filter.
  //   - ADMIN_DATABASE_URL → container superuser, bypasses RLS
  //     automatically. Tests use a dedicated client built from this
  //     URL to seed fixtures without wrestling the RLS write path.
  const appUrl = new URL(superUrl);
  appUrl.username = APP_ROLE;
  appUrl.password = APP_PASSWORD;
  process.env.DATABASE_URL = appUrl.toString();
  process.env.ADMIN_DATABASE_URL = superUrl;
}

export async function teardown(): Promise<void> {
  await container?.stop();
  container = null;
}
