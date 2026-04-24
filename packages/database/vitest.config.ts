import { defineConfig } from 'vitest/config';

// Unit-test configuration.
//
// Unit tests for @garageos/database arrive in PR 4c together with the
// Zod validators. This config exists now so `pnpm test` runs and
// reports "no tests found" instead of erroring; it also establishes the
// include pattern consumers will target.
//
// Integration tests live in their own config (vitest.integration.config.ts)
// because they require a container, a longer hook timeout, and a single
// fork to share state across suites.
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
  },
});
