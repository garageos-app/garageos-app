import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

import { startJwksServer, type JwksServer } from '../helpers/jwks-server.js';
import { publishKeysToEnv } from '../helpers/jwt.js';

// Start a Postgres container, apply migrations + seed from the sibling
// @garageos/database package, create a non-superuser role so RLS
// policies actually apply (FORCE ROW LEVEL SECURITY does not cover
// superusers), and expose DATABASE_URL + ADMIN_DATABASE_URL to worker
// processes. Copied from packages/database/tests/integration/globalSetup.ts
// with the `prisma migrate deploy` / `db:seed` calls redirected at the
// database package's cwd (@garageos/api has no prisma.config.ts of its
// own — by design, the schema is single-sourced in the database pkg).
//
// PR 7 also starts a local JWKS mock server (tests/helpers/jwks-server.ts)
// that publishes the test key pairs used to sign JWTs in integration
// tests. Its URLs are pushed into the env as COGNITO_*_JWKS_URL_OVERRIDE
// so the auth plugin's HTTP verifier fetches them instead of going to
// cognito-idp.<region>.amazonaws.com.

const POSTGRES_IMAGE = 'postgres:15-alpine';

const APP_ROLE = 'app_test';
const APP_PASSWORD = 'app';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// packages/api/tests/integration -> packages/api -> packages -> packages/database
const DATABASE_PKG = path.resolve(__dirname, '../../../database');

let container: StartedPostgreSqlContainer | null = null;
let jwksServer: JwksServer | null = null;

export async function setup(): Promise<void> {
  // --- Postgres ---
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

  // --- JWKS mock + Cognito test env ---
  // Generate the test key pairs in THIS (main) process and hand them
  // off to worker processes through env vars. The JWKS mock server
  // serves our keys; worker-side signTestToken must use the same
  // private keys or signatures will not verify.
  await publishKeysToEnv();
  jwksServer = await startJwksServer();
  process.env.COGNITO_OFFICINE_JWKS_URL_OVERRIDE = jwksServer.officineUrl;
  process.env.COGNITO_CLIENTI_JWKS_URL_OVERRIDE = jwksServer.clientiUrl;
  process.env.AWS_REGION ??= 'eu-central-1';
  process.env.COGNITO_OFFICINE_POOL_ID ??= 'eu-central-1_TESTOFFICINE';
  process.env.COGNITO_OFFICINE_CLIENT_ID ??= 'test-officine-client';
  process.env.COGNITO_CLIENTI_POOL_ID ??= 'eu-central-1_TESTCLIENTI';
  process.env.COGNITO_CLIENTI_CLIENT_ID ??= 'test-clienti-client';
}

export async function teardown(): Promise<void> {
  await jwksServer?.close();
  jwksServer = null;
  await container?.stop();
  container = null;
}
