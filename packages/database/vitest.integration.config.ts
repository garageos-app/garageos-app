import { defineConfig } from 'vitest/config';

// Integration-test configuration.
//
// `globalSetup` starts one PostgreSQL container for the entire run,
// applies migrations, and seeds system data. It exports DATABASE_URL
// into the environment; because vitest forks test workers *after*
// globalSetup completes, workers inherit that variable and can connect
// to the same container.
//
// Each test file runs in its own forked worker with fresh module
// state. This avoids the cross-file pollution we hit with a single
// shared worker (a prior file's long-lived pg.Client leaking an
// aborted-transaction state, Prisma pool handoff races, etc.).
// fileParallelism: false keeps files serial so parallel workers
// don't contend on TRUNCATE/schema locks in the shared container.
// Startup (container pull + boot + migrate + seed) takes ~5-15s on
// first run and is shared by globalSetup regardless of worker count.
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['./tests/integration/globalSetup.ts'],
    setupFiles: ['./tests/integration/setup.ts'],
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
