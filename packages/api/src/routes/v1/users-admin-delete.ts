// DELETE /v1/users/:id — F-OFF-004 admin soft-delete.
//
// Auth chain: requireAuth → requireOfficinaPool → tenantContext → requireSuperAdmin
// RLS context: role: 'admin' required for writes.
//
// Business rules enforced:
//   BR-203 — last super_admin guard: prevents the tenant from having zero
//             active super_admins by blocking deletion of the last one.
//
// Error codes:
//   user.cannot_delete_self_via_admin — 422: actor tries to delete themselves
//   user.not_found                    — 404: target missing or cross-tenant
//   user.last_super_admin             — 409: BR-203 violation

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { env } from '../../config/env.js';
import { businessError } from '../../lib/business-error.js';
import { signOutOfficineUser } from '../../lib/cognito.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';
import { requireSuperAdmin } from '../../middleware/require-super-admin.js';

const ParamsSchema = z.object({ id: z.string().uuid() });

export const usersAdminDeleteRoutes: FastifyPluginAsync = async (app) => {
  app.delete(
    '/v1/users/:id',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext, requireSuperAdmin],
    },
    async (request, reply) => {
      const parsedParams = ParamsSchema.safeParse(request.params);
      if (!parsedParams.success) throw parsedParams.error;
      const targetId = parsedParams.data.id;
      const tenantId = request.tenantId!;
      const actorCognitoSub = request.userId!;

      const targetInfo = await app.withContext({ role: 'admin' as const }, async (tx) => {
        // Look up the actor's DB UUID so the audit log actor_id column
        // (UUID) is correctly populated — cognitoSub is opaque, NOT a UUID.
        // Same pattern as users-admin-update.ts.
        const actor = await tx.user.findFirst({
          where: { cognitoSub: actorCognitoSub, tenantId },
          select: { id: true },
        });

        // Guard: cannot delete self via this admin endpoint.
        if (actor?.id === targetId) {
          throw businessError(
            'user.cannot_delete_self_via_admin',
            422,
            'Non puoi rimuovere te stesso da qui. Usa il profilo personale.',
          );
        }

        // Lookup target (same tenant, not already soft-deleted).
        const target = await tx.user.findFirst({
          where: { id: targetId, tenantId, deletedAt: null },
          select: { id: true, email: true, role: true, status: true, cognitoSub: true },
        });
        if (!target) {
          throw businessError('user.not_found', 404, 'Utente non trovato.');
        }

        // BR-203: race-safe guard against leaving the tenant with zero active
        // super_admins. Fires only when target IS currently an active super_admin.
        //
        // Lock ALL active super_admins in the tenant (INCLUDING the target).
        // Locking the disjoint set `id <> targetId` would let two concurrent
        // cross-deletes (Tx-A locks {B'}, Tx-B locks {A'}) proceed to UPDATE
        // and deadlock on cross-row locks at UPDATE time. Locking the FULL
        // set guarantees mutual exclusion: the second tx blocks at SELECT,
        // wakes up post-commit, sees the deactivated peer, and hits the
        // guard correctly. Check is `length <= 1` because the only remaining
        // row may be the target itself.
        if (target.role === 'super_admin' && target.status === 'active') {
          const locked = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM users
            WHERE tenant_id = ${tenantId}::uuid
              AND role = 'super_admin'
              AND status = 'active'
              AND deleted_at IS NULL
            FOR UPDATE
          `;
          if (locked.length <= 1) {
            throw businessError(
              'user.last_super_admin',
              409,
              "Non puoi rimuovere l'ultimo amministratore. Promuovi prima un altro utente.",
            );
          }
        }

        // Soft-delete: set status=inactive + deletedAt=now().
        await tx.user.update({
          where: { id: targetId },
          data: { status: 'inactive', deletedAt: new Date() },
        });

        // Emit audit row. actorId uses actor?.id (DB UUID), NOT cognitoSub.
        // See CRITICAL adaptation #2 in task instructions.
        await tx.auditLog.create({
          data: {
            tenantId,
            actorType: 'user',
            actorId: actor?.id ?? null,
            action: 'user_soft_deleted',
            entityType: 'user',
            entityId: targetId,
            metadata: { targetEmail: target.email },
            ipAddress: request.ip,
          },
        });

        return { email: target.email, cognitoSub: target.cognitoSub };
      });

      // Item 1 proactive: invalidate all Cognito refresh tokens for the
      // target. Best-effort — DB soft-delete is the source of truth and
      // the reactive tenant-context lookup closes the residual window.
      // The truthy check is defensive; users.cognito_sub is non-nullable
      // at the schema level (PR #111 populates it on invitation accept).
      if (targetInfo.cognitoSub) {
        try {
          await signOutOfficineUser({
            poolId: env.COGNITO_OFFICINE_POOL_ID,
            email: targetInfo.email,
          });
        } catch (err) {
          request.log.error(
            { err, targetId },
            'cognito global signout failed (DB soft-delete already committed; user retains access until access token TTL)',
          );
        }
      }

      return reply.code(204).send();
    },
  );
};
