import pg from 'pg';

// globalSetup.ts sets DATABASE_URL on the main process before the
// worker pool is forked, so the src/client.ts singleton imported by
// the test files connects to the ephemeral test container.
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

// One pg.Client for the whole worker, shared across all test files.
// A single persistent connection avoids:
//   - pool handoff races (an INSERT's commit not yet visible to a
//     sibling pool connection)
//   - reconnect overhead on every call
//   - ghost sessions from previous tests still holding locks when a
//     new TRUNCATE tries to run
// The trade-off is that queries are serialized; for integration
// tests that's what we want anyway.
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
    // A failed query in PG leaves the session in an aborted-transaction
    // state; every subsequent query fails with "current transaction is
    // aborted" until ROLLBACK. Swallow any rollback error (we're not
    // actually in a tx most of the time).
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

// Admin-side test helpers connect as the container superuser. PG
// grants superusers BYPASSRLS automatically, so they can INSERT /
// TRUNCATE fixture data without tripping RLS policies or the BR-282
// audit immutability trigger on TRUNCATE.
export const pgAdmin = {
  query: adminQuery,
  tx: adminTx,
};

// No afterAll($disconnect) on the Prisma singleton: it's shared
// across all test files in the single worker, and disconnecting
// between files leaves subsequent files with a broken client.
// globalSetup's teardown stops the container, which closes sockets
// cleanly.
