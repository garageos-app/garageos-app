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
