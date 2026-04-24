import { defineConfig } from 'vitest/config';

// Unit-test configuration for @garageos/api.
//
// PR 5 ships only scaffold-level tests (health endpoint, 404 handler,
// request-id). Integration tests against the Prisma client arrive in
// PR 6 together with the database plugin.
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    exclude: ['tests/unit/setup.ts'],
    environment: 'node',
    passWithNoTests: true,
    setupFiles: ['./tests/unit/setup.ts'],
  },
});
