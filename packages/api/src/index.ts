import { buildServer } from './server.js';
import { env } from './config/env.js';

// Entry point executed by `node dist/index.js` (local) and by the
// Lambda Web Adapter layer (production). LWA proxies the Lambda event
// stream to this HTTP listener on AWS_LWA_PORT (8080 in the
// Dockerfile) — application code stays a vanilla Fastify server.
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
