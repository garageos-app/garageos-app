import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globals: false,
    // NodejsFunction synth runs esbuild bundling on packages/api/src/index.ts
    // which can take 30-60s on a cold cache (Task 6+). The vitest default
    // 5s testTimeout is far too short for any test that calls
    // Template.fromStack on a stack containing a NodejsFunction.
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
