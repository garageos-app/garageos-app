import { randomUUID } from 'node:crypto';
import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { env } from './config/env.js';
import databasePlugin, { type DatabasePluginOptions } from './plugins/database.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import healthRoutes from './routes/health.js';

export interface BuildServerOptions {
  // Database plugin overrides. Integration tests pass nothing and get
  // the @garageos/database singleton (real Postgres via PrismaPg);
  // unit tests pass a fake Prisma client so no TCP socket opens.
  database?: DatabasePluginOptions;
}

// Pino transport config: pretty output in development, plain JSON in
// production (consumed by CloudWatch / log aggregators).
function buildLoggerOptions() {
  if (env.NODE_ENV === 'development') {
    return {
      level: env.LOG_LEVEL,
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
      },
    };
  }
  return { level: env.LOG_LEVEL };
}

// Factory used both by the entry point and by unit tests via
// `app.inject()`. Keep it pure: no side effects beyond instantiating
// Fastify.
export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: buildLoggerOptions(),
    // trust X-Forwarded-* headers from API Gateway / ALB / LWA.
    trustProxy: true,
    disableRequestLogging: false,
    // APPENDICE_A §1.3: X-Request-ID is auto-generated when the client
    // does not supply one, and propagates to logs as `request_id`.
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'request_id',
    genReqId: () => randomUUID(),
  });

  await app.register(sensible);
  registerErrorHandler(app);
  await app.register(databasePlugin, options.database ?? {});
  await app.register(healthRoutes);

  // Echo the request id back so clients can correlate. Fastify sets
  // this by default for 2xx responses; doing it via onSend covers
  // errors too (the error handler preserves the header since it only
  // touches body/status/content-type).
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  return app;
}
