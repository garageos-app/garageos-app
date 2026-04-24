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
// PR 5 ships the scaffold-level health check. PR 6 will extend it with
// a Prisma DB ping and downgrade the status to "degraded" when the DB
// is unreachable.
export default async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', { logLevel: 'silent' }, async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: env.APP_VERSION,
  }));
}
