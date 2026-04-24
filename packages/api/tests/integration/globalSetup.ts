import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

// Start a Postgres container, apply migrations + seed from the sibling
// @garageos/database package, create a non-superuser role so RLS
// policies actually apply (FORCE ROW LEVEL SECURITY does not cover
// superusers), and expose DATABASE_URL + ADMIN_DATABASE_URL to worker
// processes. Copied from packages/database/tests/integration/globalSetup.ts
// with the `prisma migrate deploy` / `db:seed` calls redirected at the
// database package's cwd (@garageos/api has no prisma.config.ts of its
// own — by design, the schema is single-sourced in the database pkg).

const POSTGRES_IMAGE = 'postgres:15-alpine';

const APP_ROLE = 'app_test';
const APP_PASSWORD = 'app';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// packages/api/tests/integration -> packages/api -> packages -> packages/database
const DATABASE_PKG = path.resolve(__dirname, '../../../database');

let container: StartedPostgreSqlContainer | null = null;

export async function setup(): Promise<void> {
  container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase('garageos_test')
    .withUsername('test')
    .withPassword('test')
    .start();

  const superUrl = container.getConnectionUri();

  process.env.DATABASE_URL = superUrl;
  process.env.DIRECT_URL = superUrl;
  execSync('pnpm prisma migrate deploy', { stdio: 'inherit', cwd: DATABASE_PKG });
  execSync('pnpm db:seed', { stdio: 'inherit', cwd: DATABASE_PKG });

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
