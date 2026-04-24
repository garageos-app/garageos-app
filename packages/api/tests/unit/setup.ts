// Force NODE_ENV to test so `buildServer` skips the pino-pretty
// transport (pino-pretty spawns a worker thread that keeps the event
// loop alive and breaks `vitest --run`'s clean exit).
process.env.NODE_ENV ??= 'test';
process.env.LOG_LEVEL ??= 'silent';
