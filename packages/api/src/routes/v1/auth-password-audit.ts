// Password audit-notify endpoints (hardening, BR-280).
//
// The real password change/reset happens client-side via Cognito (the
// backend only ever sees the ID token, never the AccessToken that Cognito
// ChangePassword requires — see plugins/auth.ts customJwtCheck). These
// endpoints exist solely to record a forensic audit_logs row plus a thin
// per-IP rate-limit. See spec 2026-06-03-password-change-backend-audit-design.md.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

// Email body schema for the public reset-completed endpoint.
// Trims and lowercases the email to normalise Cognito's case-insensitive
// addresses before the DB lookup.
const ResetBodySchema = z.object({
  email: z
    .email()
    .max(255)
    .transform((s) => s.trim().toLowerCase()),
});

// Shared rate-limit error builder — mirrors auth-signup.ts. Returns an Error
// whose dotted `name` flows through the global error handler to a
// Problem+JSON response with the matching `code`.
function rateLimitError(code: string, ttlMs: number): Error {
  const retryAfter = Math.ceil(ttlMs / 1000);
  const err = new Error(
    `Troppi tentativi. Riprova tra qualche minuto. Retry dopo ${retryAfter}s.`,
  ) as Error & { statusCode: number; retryAfter: number };
  err.name = code;
  err.statusCode = 429;
  err.retryAfter = retryAfter;
  return err;
}

export const authPasswordAuditRoutes: FastifyPluginAsync = async (app) => {
  // ── Authenticated change-notify ──────────────────────────────────────────
  app.post(
    '/v1/auth/password-changed',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '15 minutes',
          errorResponseBuilder: (_req, ctx) =>
            rateLimitError('auth.password_change.rate_limited', ctx.ttl),
        },
      },
    },
    async (request, reply) => {
      const tenantId = request.tenantId!;
      const actorCognitoSub = request.userId!;
      await app.withContext({ role: 'admin' as const }, async (tx) => {
        // Resolve the actor's DB UUID (request.userId is the opaque Cognito
        // sub). Same lookup pattern as users-admin-update.ts.
        const actor = await tx.user.findFirst({
          where: { cognitoSub: actorCognitoSub, tenantId },
          select: { id: true },
        });
        if (!actor) {
          request.log.warn(
            { actorCognitoSub, tenantId },
            'password-changed: actor not found, skipping audit row',
          );
          return;
        }
        // BR-280: password change is a security event that must be audited.
        await tx.auditLog.create({
          data: {
            tenantId,
            actorType: 'user',
            actorId: actor.id,
            action: 'user_password_changed',
            entityType: 'user',
            entityId: actor.id,
            metadata: {},
            ipAddress: request.ip,
          },
        });
      });
      return reply.code(204).send();
    },
  );

  // ── Public reset-completed-notify ────────────────────────────────────────
  // Unauthenticated: during forgot-password the user has no session. Always
  // returns a constant 204 (anti-enumeration). Writes audit rows only when an
  // active officine user matches the email. users.email is NOT unique, so we
  // iterate all matches and write one row per (user, tenant).
  app.post(
    '/v1/auth/password-reset-completed',
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '15 minutes',
          errorResponseBuilder: (_req, ctx) =>
            rateLimitError('auth.password_reset.rate_limited', ctx.ttl),
        },
      },
    },
    async (request, reply) => {
      const parsed = ResetBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw parsed.error;
      }
      const email = parsed.data.email;

      // role:'admin' bypasses the users RLS for this cross-tenant write with
      // no JWT — same rationale as auth-signup.ts.
      await app.withContext({ role: 'admin' as const }, async (tx) => {
        const users = await tx.user.findMany({
          where: { email, status: 'active', deletedAt: null },
          select: { id: true, tenantId: true },
        });
        for (const u of users) {
          // BR-280: password reset is a security event that must be audited.
          await tx.auditLog.create({
            data: {
              tenantId: u.tenantId,
              actorType: 'user',
              actorId: u.id,
              action: 'user_password_reset',
              entityType: 'user',
              entityId: u.id,
              metadata: {},
              ipAddress: request.ip,
            },
          });
        }
      });
      return reply.code(204).send();
    },
  );
};
