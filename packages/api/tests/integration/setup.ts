import pg from 'pg';

// globalSetup.ts sets DATABASE_URL / ADMIN_DATABASE_URL on the main
// process before the worker pool is forked; workers inherit both.
// The Prisma singleton imported transitively via src/plugins/database.ts
// reads DATABASE_URL at module load, so the app under test points at
// the ephemeral container.
if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is not set. Ensure vitest.integration.config.ts declares ./tests/integration/globalSetup.ts in globalSetup.',
  );
}

const adminUrl = process.env.ADMIN_DATABASE_URL;
if (!adminUrl) {
  throw new Error(
    'ADMIN_DATABASE_URL is not set. globalSetup should export it alongside DATABASE_URL.',
  );
}

// One persistent pg.Client per worker, shared across all test files in
// that worker. Mirrors packages/database/tests/integration/setup.ts —
// see the comment there for the race-condition / reconnect rationale.
const adminClient = new pg.Client({ connectionString: adminUrl });
let adminConnected = false;

async function ensureAdminConnected(): Promise<void> {
  if (!adminConnected) {
    await adminClient.connect();
    adminConnected = true;
  }
}

async function adminQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  await ensureAdminConnected();
  try {
    return await adminClient.query<T>(sql, params);
  } catch (err) {
    try {
      await adminClient.query('ROLLBACK');
    } catch {
      // no-op
    }
    throw err;
  }
}

async function adminTx<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  await ensureAdminConnected();
  try {
    await adminClient.query('BEGIN');
    const result = await fn(adminClient);
    await adminClient.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await adminClient.query('ROLLBACK');
    } catch {
      // no-op
    }
    throw err;
  }
}

export const pgAdmin = {
  query: adminQuery,
  tx: adminTx,
};

// Intentionally no afterAll($disconnect) on the Prisma singleton: the
// cached client is shared across integration-test files via globalThis
// and disconnecting between files leaves subsequent files with a broken
// client. globalSetup's teardown stops the container, which closes
// sockets cleanly. The database plugin's onClose already skips
// $disconnect under NODE_ENV=test (see src/plugins/database.ts).
