// DELETE /v1/users/invitations/:id — F-OFF-004 Super Admin invitation revoke.
//
// Tombstones the invitation by setting acceptedAt = now(). No separate
// revokedAt column exists — the tombstone semantics are shared with the
// normal acceptance flow, and the audit log action distinguishes the two
// cases (user_invitation_revoked vs user_invitation_accepted).
//
// Auth chain: requireAuth → requireOfficinaPool → tenantContext → requireSuperAdmin
// RLS context: role: 'admin' required for writes (per feedback_withcontext_empty_blocks_rls_writes).
//
// Error codes:
//   user.invitation.not_found    — 404 for missing or cross-tenant invitation
//   user.invitation.already_accepted — 410 for already tombstoned invitation

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { businessError } from '../../lib/business-error.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';
import { requireSuperAdmin } from '../../middleware/require-super-admin.js';

const ParamsSchema = z.object({ id: z.string().uuid() });

export const usersInvitationsRevokeRoutes: FastifyPluginAsync = async (app) => {
  app.delete(
    '/v1/users/invitations/:id',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext, requireSuperAdmin],
    },
    async (request, reply) => {
      const parsed = ParamsSchema.safeParse(request.params);
      if (!parsed.success) throw parsed.error;

      const tenantId = request.tenantId!;
      // request.userId is the Cognito sub (opaque string, NOT a UUID).
      // We look up the actor's DB UUID inside the transaction so the audit
      // log actor_id column (UUID) is correctly populated.
      // See feedback_handler_change_breaks_unit_mock and the same pattern
      // in users-invitations-create.ts (T6 actorId fix).
      const actorCognitoSub = request.userId!;

      await app.withContext({ role: 'admin' as const }, async (tx) => {
        const inv = await tx.invitation.findFirst({
          where: {
            id: parsed.data.id,
            tenantId,
            invitationType: 'internal_user',
          },
        });

        if (!inv) {
          throw businessError('user.invitation.not_found', 404, 'Invito non trovato.');
        }

        if (inv.acceptedAt) {
          throw businessError(
            'user.invitation.already_accepted',
            410,
            'Questo invito è già stato accettato o revocato.',
          );
        }

        // Tombstone: reuse acceptedAt as the revocation marker — same column
        // that the acceptance flow sets. The audit action distinguishes revocation.
        await tx.invitation.update({
          where: { id: inv.id },
          data: { acceptedAt: new Date() },
        });

        // Look up the revoking user's DB UUID — cognitoSub is an opaque string
        // that cannot be stored directly in the UUID audit_logs.actor_id column.
        const actorUser = await tx.user.findFirst({
          where: { cognitoSub: actorCognitoSub, tenantId },
          select: { id: true },
        });

        await tx.auditLog.create({
          data: {
            tenantId,
            actorType: 'user',
            actorId: actorUser?.id ?? null,
            action: 'user_invitation_revoked',
            entityType: 'invitation',
            entityId: inv.id,
            metadata: { targetEmail: inv.targetEmail },
            ipAddress: request.ip,
          },
        });
      });

      return reply.code(204).send();
    },
  );
};
