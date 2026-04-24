import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Integration-test configuration for @garageos/api.
//
// Mirrors the database package's pattern: one PostgreSQL container for
// the entire run started by globalSetup, migrations from
// packages/database applied there, workers forked afterwards so they
// inherit DATABASE_URL / ADMIN_DATABASE_URL. fileParallelism is off so
// tests do not contend on TRUNCATE / schema locks in the shared DB.
export default defineConfig({
  resolve: {
    alias: {
      '@garageos/database': path.resolve(__dirname, '../database/src/index.ts'),
    },
  },
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
