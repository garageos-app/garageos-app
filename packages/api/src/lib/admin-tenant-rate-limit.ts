// Shared rate-limit configuration for platform-admin tenant mutation routes
// (POST /v1/admin/tenants and POST /v1/admin/tenants/:id/regenerate-invitation).
//
// WHY a shared module: both routes carried a byte-identical `config.rateLimit`
// block. Centralising here removes duplication and fixes the broken keyGenerator.

import type { FastifyRequest } from 'fastify';

/**
 * Rate-limit key generator for platform-admin /v1/admin/tenants* routes.
 *
 * @fastify/rate-limit executes its keyGenerator at the onRequest phase, which
 * runs BEFORE the requireAuth preHandler that populates `request.jwt`. As a
 * result, `request.jwt` is ALWAYS undefined here and cannot be used as the key.
 *
 * Instead, we decode the *unverified* `sub` claim from the Bearer token
 * directly. This is safe for bucketing purposes: a token with a forged sub
 * still 401s at requireAuth and causes no side-effects; we act only on the
 * real, verified payload further down the handler chain. Reading an unverified
 * claim purely for rate-limit keying does not weaken the auth contract.
 *
 * On any failure (missing/malformed Authorization header, bad base64url, no
 * `sub` claim, JSON parse error) the function falls back to the request IP.
 * The entire body is wrapped in try/catch — a throwing keyGenerator would
 * produce a 500 on every request to these routes.
 */
export function adminTenantRateLimitKey(request: FastifyRequest): string {
  try {
    const auth = request.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      return `admin-tenant-ip:${request.ip}`;
    }
    const token = auth.slice(7); // strip "Bearer "
    const parts = token.split('.');
    if (parts.length < 2) {
      return `admin-tenant-ip:${request.ip}`;
    }
    const payloadJson = Buffer.from(parts[1]!, 'base64url').toString('utf8');
    const payload = JSON.parse(payloadJson) as unknown;
    if (payload !== null && typeof payload === 'object') {
      // Extract `sub` as unknown first, then narrow — avoids noUncheckedIndexedAccess
      // TS2532 that would occur on direct Record<string,string>[key].length access.
      const sub = (payload as Record<string, unknown>)['sub'];
      if (typeof sub === 'string' && sub.length > 0) {
        return `admin-tenant:${sub}`;
      }
    }
    return `admin-tenant-ip:${request.ip}`;
  } catch {
    return `admin-tenant-ip:${request.ip}`;
  }
}

// Shared rate-limit config: 30 calls per hour per platform-admin sub.
// Imported by admin-tenants-create.ts and admin-tenants-regenerate-invitation.ts.
export const adminTenantRateLimitConfig = {
  max: 30,
  timeWindow: '1 hour',
  keyGenerator: adminTenantRateLimitKey,
  errorResponseBuilder: (_req: FastifyRequest, ctx: { ttl: number }) => {
    const retryAfter = Math.ceil(ctx.ttl / 1000);
    const err = new Error(
      `Troppi tentativi. Riprova tra un'ora. Retry dopo ${retryAfter}s.`,
    ) as Error & { statusCode: number; retryAfter: number };
    err.name = 'admin.tenant.rate_limited';
    err.statusCode = 429;
    err.retryAfter = retryAfter;
    return err;
  },
} as const;
