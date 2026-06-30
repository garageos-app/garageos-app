// POST /v1/users/:id/reactivate — F-OFF-004 reactivation (slice 2026-05-21).
//
// Inverte la soft-delete (UPDATE users SET deletedAt=NULL, status='active'),
// con override opzionale di role, e Cognito AdminEnableUser best-effort post-tx.
// Mirror simmetrico del DELETE /v1/users/:id.
//
// Auth chain: requireAuth → requireOfficinaPool → tenantContext → requireSuperAdmin
// RLS context: role: 'admin' required for writes.
//
// Business rules enforced:
//   BR-212 — riattivazione utente (vedi APPENDICE_F)
//
// Error codes:
//   user.not_found                       — 404: target non soft-deleted o cross-tenant
//   user.already_active                  — 422: defensive guard (race / replay)
//
// See docs/superpowers/specs/2026-05-21-user-reactivation-design.md §4.1.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { env } from '../../config/env.js';
import { businessError } from '../../lib/business-error.js';
import { enableOfficineUser, updateOfficineUserRoleAndLocation } from '../../lib/cognito.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';
import { requireSuperAdmin } from '../../middleware/require-super-admin.js';
import { USER_ADMIN_SELECT, serializeUserAdmin } from '../../lib/dtos/user-admin.js';

const ParamsSchema = z.object({ id: z.string().uuid() });

const BodySchema = z.object({
  role: z.enum(['super_admin', 'mechanic']).optional(),
});

export const usersAdminReactivateRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/v1/users/:id/reactivate',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext, requireSuperAdmin],
    },
    async (request, reply) => {
      const parsedParams = ParamsSchema.safeParse(request.params);
      if (!parsedParams.success) throw parsedParams.error;
      const parsedBody = BodySchema.safeParse(request.body);
      if (!parsedBody.success) throw parsedBody.error;

      const tenantId = request.tenantId!;
      const actorCognitoSub = request.userId!;
      const targetId = parsedParams.data.id;
      const body = parsedBody.data;

      const result = await app.withContext({ role: 'admin' as const }, async (tx) => {
        // Lookup target — MUST be soft-deleted (deletedAt: { not: null }).
        // A target with deletedAt=null is either not found or already
        // active — both surface as 404 to the caller (the active case is
        // unreachable via UI but defensive against direct API calls).
        const target = await tx.user.findFirst({
          where: { id: targetId, tenantId, deletedAt: { not: null } },
          select: {
            id: true,
            email: true,
            role: true,
            status: true,
            cognitoSub: true,
            deletedAt: true,
          },
        });
        if (!target) {
          throw businessError('user.not_found', 404, 'Utente non trovato.');
        }

        // Defensive idempotency guard: the where-clause above excludes
        // deletedAt=null targets, but keep this guard for race / replay
        // safety (spec §4.1 step 2).
        if (target.status === 'active' && target.deletedAt === null) {
          throw businessError('user.already_active', 422, 'Utente già attivo.');
        }

        // Compute effective new role: override if body provides, else preserve
        // the pre-deactivation value from the target row.
        const newRole = body.role ?? target.role;

        // Persist: clear soft-delete + optional role override. Only include
        // override fields explicitly so Prisma doesn't issue redundant
        // SET clauses on unchanged columns.
        const updated = await tx.user.update({
          where: { id: targetId },
          data: {
            deletedAt: null,
            status: 'active',
            ...(body.role !== undefined ? { role: body.role } : {}),
          },
          select: USER_ADMIN_SELECT,
        });

        // Look up actor's DB UUID for the audit log (cognitoSub is opaque,
        // cannot be stored in UUID column). Same pattern as
        // users-admin-update.ts / users-admin-delete.ts.
        const actorUser = await tx.user.findFirst({
          where: { cognitoSub: actorCognitoSub, tenantId },
          select: { id: true },
        });

        await tx.auditLog.create({
          data: {
            tenantId,
            actorType: 'user',
            actorId: actorUser?.id ?? null,
            action: 'user_reactivated',
            entityType: 'user',
            entityId: targetId,
            metadata: {
              targetEmail: target.email,
              previousStatus: target.status,
              previousDeletedAt: target.deletedAt!.toISOString(),
              roleOverridden: body.role !== undefined,
              newRole,
            },
            ipAddress: request.ip,
          },
        });

        return {
          user: updated,
          targetEmail: target.email,
          targetCognitoSub: target.cognitoSub,
          roleOverridden: body.role !== undefined,
        };
      });

      // Cognito sync — best-effort, outside the DB transaction. DB is the
      // source of truth; if Cognito fails, operator can retry or apply
      // manual fix-up. We surface a hint to the caller via header.
      let cognitoSyncFailed = false;
      try {
        await enableOfficineUser({
          poolId: env.COGNITO_OFFICINE_POOL_ID,
          email: result.targetEmail,
        });
      } catch (err) {
        cognitoSyncFailed = true;
        request.log.error(
          { err, targetId },
          'cognito AdminEnableUser failed during reactivate (DB committed; operator must enable manually)',
        );
      }

      if (result.roleOverridden) {
        try {
          await updateOfficineUserRoleAndLocation({
            poolId: env.COGNITO_OFFICINE_POOL_ID,
            email: result.targetEmail,
            ...(body.role !== undefined ? { role: body.role } : {}),
          });
        } catch (err) {
          cognitoSyncFailed = true;
          request.log.error(
            { err, targetId },
            'cognito attribute sync failed during reactivate (DB committed; takes effect on next JWT refresh)',
          );
        }
      }

      if (cognitoSyncFailed) {
        reply.header('x-cognito-sync-failed', 'true');
      }
      return reply.code(200).send({ user: serializeUserAdmin(result.user) });
    },
  );
};
