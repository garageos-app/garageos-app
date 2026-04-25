import { randomUUID } from 'node:crypto';

import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';

import { env } from './config/env.js';
import authPlugin, { type AuthPluginOptions } from './plugins/auth.js';
import databasePlugin, { type DatabasePluginOptions } from './plugins/database.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import helmetPlugin from './plugins/helmet.js';
import healthRoutes from './routes/health.js';
import interventionRoutes from './routes/v1/interventions.js';
import meVehicleRoutes from './routes/v1/me-vehicles.js';
import userRoutes from './routes/v1/users.js';
import tenantRoutes from './routes/v1/tenants.js';
import vehicleTimelineRoutes from './routes/v1/vehicles-timeline.js';
import vehicleRoutes from './routes/v1/vehicles.js';

export interface BuildServerOptions {
  // Database plugin overrides. Integration tests pass nothing and get
  // the @garageos/database singleton (real Postgres via PrismaPg);
  // unit tests pass a fake Prisma client so no TCP socket opens.
  database?: DatabasePluginOptions;
  // Auth plugin overrides. Integration tests point the verifier at the
  // local JWKS mock (via COGNITO_*_JWKS_URL_OVERRIDE env) and leave
  // this empty; unit tests with direct app.inject can pass in-memory
  // JWKs here to bypass HTTP entirely. See src/plugins/auth.ts.
  auth?: AuthPluginOptions;
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
//
// Plugin registration order matters:
//   1. helmet   — security headers must wrap every response including
//                  errors, so it goes FIRST (its onSend hook covers
//                  Problem Details responses too).
//   2. sensible — HTTP error helpers used by the error handler.
//   3. error    — error handler installed before any route.
//   4. database — decorates prisma + withContext; routes depend on it.
//   5. auth     — decorates jwtVerifier; routes + middleware depend on it.
//   6. routes   — operational (/health) at root, business under /v1.
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

  await app.register(helmetPlugin);
  await app.register(sensible);
  registerErrorHandler(app);
  await app.register(databasePlugin, options.database ?? {});
  await app.register(authPlugin, options.auth ?? {});
  await app.register(healthRoutes);
  await app.register(userRoutes);
  await app.register(tenantRoutes);
  await app.register(vehicleRoutes);
  await app.register(vehicleTimelineRoutes);
  await app.register(interventionRoutes);
  await app.register(meVehicleRoutes);

  // Echo the request id back so clients can correlate. Fastify sets
  // this by default for 2xx responses; doing it via onSend covers
  // errors too (the error handler preserves the header since it only
  // touches body/status/content-type).
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  return app;
}
