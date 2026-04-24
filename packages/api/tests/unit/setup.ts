// Force NODE_ENV to test so `buildServer` skips the pino-pretty
// transport (pino-pretty spawns a worker thread that keeps the event
// loop alive and breaks `vitest --run`'s clean exit).
process.env.NODE_ENV ??= 'test';
process.env.LOG_LEVEL ??= 'silent';
// env.ts requires DATABASE_URL via Zod; a placeholder is enough because
// PrismaPg opens the TCP connection lazily and unit tests replace the
// Prisma client with fakes via plugin options before any query runs.
// Mirror of packages/database/tests/unit/setup.ts.
process.env.DATABASE_URL ??= 'postgresql://unit:unit@localhost:5432/unit_no_connect';

// PR 7: env.ts now validates Cognito config at module load. Unit tests
// always mock the verifier (see tests/unit/plugins/auth.test.ts for the
// in-memory JWK injection path), so the values below are only needed to
// pass Zod's schema parse; nothing ever calls AWS with them.
process.env.AWS_REGION ??= 'eu-central-1';
process.env.COGNITO_OFFICINE_POOL_ID ??= 'eu-central-1_TESTOFFICINE';
process.env.COGNITO_OFFICINE_CLIENT_ID ??= 'test-officine-client';
process.env.COGNITO_CLIENTI_POOL_ID ??= 'eu-central-1_TESTCLIENTI';
process.env.COGNITO_CLIENTI_CLIENT_ID ??= 'test-clienti-client';

// Generate the RS256 key pairs used to sign test JWTs (see
// tests/helpers/jwt.ts). Top-level await keeps the rest of the suite
// from running before keys are ready — signTestToken / getTestKey
// throw if called before initKeys resolves.
import { initKeys } from '../helpers/jwt.js';

await initKeys();
