import { vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

// Stub Cognito env vars so packages/web/src/lib/cognito.ts module-init
// does not throw when test files import code that depends on it. These
// values are intentionally fake — Cognito SDK calls are mocked in each
// test that exercises auth flows.
vi.stubEnv('VITE_COGNITO_OFFICINE_POOL_ID', 'eu-central-1_test');
vi.stubEnv('VITE_COGNITO_OFFICINE_CLIENT_ID', 'test-client-id');
