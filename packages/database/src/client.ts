import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../prisma/generated/prisma/client/client.js';

type LogLevel = 'query' | 'info' | 'warn' | 'error';

function resolveLogConfig(): LogLevel[] {
  const level = process.env.DATABASE_LOG_LEVEL?.toLowerCase();
  switch (level) {
    case 'debug':
      return ['query', 'info', 'warn', 'error'];
    case 'info':
      return ['info', 'warn', 'error'];
    case 'warn':
      return ['warn', 'error'];
    case 'error':
    case undefined:
    case '':
      return ['error'];
    default:
      return ['error'];
  }
}

function createClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      '@garageos/database: DATABASE_URL is not set. In Lambda it is injected from Secrets Manager at cold start; locally, copy packages/database/.env.example to .env.local and fill in your Supabase pooler URL.',
    );
  }

  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter, log: resolveLogConfig() });
}

// Singleton strategy:
//   - In AWS Lambda (AWS_LAMBDA_FUNCTION_NAME is set by the runtime),
//     reuse one PrismaClient per container for the lifetime of that
//     execution environment. Cold start creates it; subsequent warm
//     invocations share it.
//   - Outside Lambda (local dev, tests, CI migrate:deploy) we also
//     cache on globalThis so tsx/vitest HMR doesn't spawn a client
//     per reload.
const isLambda = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
const globalForPrisma = globalThis as unknown as { __garageosPrisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.__garageosPrisma ?? createClient();

if (!isLambda && process.env.NODE_ENV !== 'production') {
  globalForPrisma.__garageosPrisma = prisma;
}

/**
 * Run a unit of work with tenant/customer context set at the PostgreSQL
 * session level. Row-Level Security policies (introduced in PR 5) will
 * read these settings via `current_setting('app.current_tenant')` to
 * scope every query to the caller's tenant and customer.
 *
 * In PR 4 this helper is a no-op on the database because no RLS
 * policies reference the settings yet, but the API surface is stable
 * so call sites can adopt it now.
 *
 * @see docs/APPENDICE_B_DATABASE.md §6.1
 */
export async function withContext<T>(
  ctx: { tenantId?: string; customerId?: string; role?: 'admin' | 'user' },
  fn: (tx: PrismaClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    if (ctx.tenantId) {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_tenant', $1, true)`, ctx.tenantId);
    }
    if (ctx.customerId) {
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_customer', $1, true)`,
        ctx.customerId,
      );
    }
    if (ctx.role === 'admin') {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_role', 'admin', true)`);
    }
    return fn(tx as unknown as PrismaClient);
  });
}
