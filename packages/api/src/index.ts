import { loadSecretsIntoEnv } from './config/secrets.js';

// Lambda runtime requires `handler` to exist on the entry module; the
// LWA layer intercepts events at the runtime-extension level before
// they reach this function, so the body should never run in normal
// operation. Throwing makes a regression where LWA fails to attach
// loudly visible in CloudWatch.
export const handler = async (): Promise<never> => {
  throw new Error('Lambda Web Adapter should have intercepted this invocation');
};

// Step 1 of cold-start boot: hydrate process.env from Secrets Manager
// (APP_SECRETS_ARN is set by CDK in the Lambda env). No-op outside
// Lambda — local dev and tests rely on .env / .env.local.
await loadSecretsIntoEnv();

// Step 2: dynamic-import every module that reads env at module-load
// time. Static imports would parse env BEFORE step 1 had populated
// it, defeating the whole point of the Secrets Manager fetch.
const { buildServer } = await import('./server.js');
const { env } = await import('./config/env.js');

const app = await buildServer();

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'error during shutdown');
    process.exit(1);
  }
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ host: '0.0.0.0', port: env.PORT });
} catch (err) {
  app.log.error({ err }, 'server failed to start');
  process.exit(1);
}
