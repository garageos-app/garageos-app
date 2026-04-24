import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Unit-test configuration for @garageos/api.
//
// The alias re-routes `@garageos/database` to its TypeScript source so
// vitest does not require the database package to be tsc-built before
// tests run. Production consumers read the package through main/exports
// which points at dist/index.js — see packages/database/package.json.
export default defineConfig({
  resolve: {
    alias: {
      '@garageos/database': path.resolve(__dirname, '../database/src/index.ts'),
    },
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    exclude: ['tests/unit/setup.ts'],
    environment: 'node',
    passWithNoTests: true,
    setupFiles: ['./tests/unit/setup.ts'],
  },
});
