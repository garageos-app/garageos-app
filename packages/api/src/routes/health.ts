import type { FastifyInstance } from 'fastify';
import { env } from '../config/env.js';

// Operational liveness/readiness probe.
//
// Path `/health` is required at root (no /v1 prefix) because AWS Lambda
// Web Adapter uses it as its readiness check — see APPENDICE_C §5.9,
// AWS_LWA_READINESS_CHECK_PATH=/health. Logging is silenced to avoid
// cluttering logs with high-frequency probes (LWA polls during cold
// start; future ALB/APIGW health checks will too).
//
// PR 6 adds a light DB ping: `SELECT 1` via Prisma with a 2 s race
// timeout. The endpoint returns 200 / `status: ok` when the DB is
// reachable, 503 / `status: degraded` otherwise. The underlying error
// is logged server-side and never leaked to the response body — LWA /
// ALB only care about the status code. `/health` is operational, not
// part of the /v1 public API surface, so it does not use RFC 7807.

const DB_PING_TIMEOUT_MS = 2_000;

interface HealthBody {
  status: 'ok' | 'degraded';
  timestamp: string;
  version: string;
  services: { database: 'ok' | 'error' };
}

export default async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', { logLevel: 'silent' }, async (request, reply) => {
    const timer: { handle?: NodeJS.Timeout } = {};
    const timeout = new Promise<never>((_, rej) => {
      timer.handle = setTimeout(
        () => rej(new Error(`db ping timed out after ${DB_PING_TIMEOUT_MS}ms`)),
        DB_PING_TIMEOUT_MS,
      );
    });

    let dbOk = true;
    try {
      await Promise.race([app.prisma.$queryRaw`SELECT 1`, timeout]);
    } catch (err) {
      dbOk = false;
      request.log.error({ err }, 'health: database ping failed');
    } finally {
      if (timer.handle) clearTimeout(timer.handle);
    }

    const body: HealthBody = {
      status: dbOk ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      version: env.APP_VERSION,
      services: { database: dbOk ? 'ok' : 'error' },
    };

    return reply.status(dbOk ? 200 : 503).send(body);
  });
}
