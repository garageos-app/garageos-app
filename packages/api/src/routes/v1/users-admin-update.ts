// PATCH /v1/users/:id — F-OFF-004 admin update user role/location/status.
//
// Auth chain: requireAuth → requireOfficinaPool → tenantContext → requireSuperAdmin
// RLS context: role: 'admin' required for writes.
//
// Business rules enforced:
//   BR-203 — last super_admin guard: prevents the tenant from having zero
//             active super_admins by blocking demotion (role change) or
//             deactivation (status=inactive) of the last one.
//   BR-204 — mechanic location required: a user with role=mechanic must
//             always be assigned to a location.
//
// Error codes:
//   user.not_found                       — 404: target missing or cross-tenant
//   user.last_super_admin                — 409: BR-203 violation
//   user.location_required_for_mechanic  — 422: BR-204 violation
//   user.location_invalid                — 422: locationId not in tenant or inactive

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { env } from '../../config/env.js';
import { businessError } from '../../lib/business-error.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';
import { requireSuperAdmin } from '../../middleware/require-super-admin.js';
import { updateOfficineUserRoleAndLocation } from '../../lib/cognito.js';
import { USER_ADMIN_SELECT, serializeUserAdmin } from '../../lib/dtos/user-admin.js';

const ParamsSchema = z.object({ id: z.string().uuid() });

const BodySchema = z
  .object({
    role: z.enum(['super_admin', 'mechanic']).optional(),
    locationId: z.string().uuid().nullable().optional(),
    status: z.enum(['active', 'inactive']).optional(),
  })
  .refine((d) => d.role !== undefined || d.locationId !== undefined || d.status !== undefined, {
    message: 'At least one field (role, locationId, status) must be present',
  });

export const usersAdminUpdateRoutes: FastifyPluginAsync = async (app) => {
  app.patch(
    '/v1/users/:id',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext, requireSuperAdmin],
    },
    async (request, reply) => {
      const parsedParams = ParamsSchema.safeParse(request.params);
      if (!parsedParams.success) throw parsedParams.error;

      const parsedBody = BodySchema.safeParse(request.body);
      if (!parsedBody.success) throw parsedBody.error;

      const tenantId = request.tenantId!;
      // request.userId is the Cognito sub (opaque string, NOT a UUID).
      // We look up the actor's DB UUID inside the transaction so the audit
      // log actor_id column (UUID) is correctly populated.
      // See users-invitations-revoke.ts for the same pattern.
      const actorCognitoSub = request.userId!;
      const targetId = parsedParams.data.id;
      const body = parsedBody.data;

      const result = await app.withContext({ role: 'admin' as const }, async (tx) => {
        // Lookup target user (same tenant, not soft-deleted).
        const target = await tx.user.findFirst({
          where: { id: targetId, tenantId, deletedAt: null },
          select: { id: true, email: true, role: true, locationId: true, status: true },
        });
        if (!target) {
          throw businessError('user.not_found', 404, 'Utente non trovato.');
        }

        // Compute effective new values.
        const newRole = body.role ?? target.role;
        const newLocationId = body.locationId !== undefined ? body.locationId : target.locationId;
        const newStatus = body.status ?? target.status;

        // BR-204: a mechanic must always be assigned to a location. See BR-204.
        if (newRole === 'mechanic' && !newLocationId) {
          throw businessError(
            'user.location_required_for_mechanic',
            422,
            'Un meccanico deve essere assegnato a una sede.',
          );
        }

        // BR-203: guard against leaving the tenant with zero active super_admins.
        // Fires only when the target IS currently an active super_admin AND the
        // new state would no longer be an active super_admin (either role changed
        // away from super_admin, or status changed to inactive). See BR-203.
        const isLosingAdmin =
          target.role === 'super_admin' &&
          target.status === 'active' &&
          (newRole !== 'super_admin' || newStatus !== 'active');

        if (isLosingAdmin) {
          const remainingAdmins = await tx.user.count({
            where: {
              tenantId,
              role: 'super_admin',
              status: 'active',
              deletedAt: null,
              id: { not: targetId },
            },
          });
          if (remainingAdmins === 0) {
            throw businessError(
              'user.last_super_admin',
              409,
              "Non puoi rimuovere l'ultimo amministratore. Promuovi prima un altro utente.",
            );
          }
        }

        // Validate locationId — if provided and non-null, must belong to same
        // tenant and be active.
        if (body.locationId !== undefined && body.locationId !== null) {
          const loc = await tx.location.findFirst({
            where: { id: body.locationId, tenantId, status: 'active', deletedAt: null },
          });
          if (!loc) {
            throw businessError('user.location_invalid', 422, 'Sede non valida o inattiva.');
          }
        }

        // Persist — only include fields that were explicitly provided.
        const updated = await tx.user.update({
          where: { id: targetId },
          data: {
            ...(body.role !== undefined ? { role: body.role } : {}),
            ...(body.locationId !== undefined ? { locationId: body.locationId } : {}),
            ...(body.status !== undefined ? { status: body.status } : {}),
          },
          select: USER_ADMIN_SELECT,
        });

        // Look up actor's DB UUID for the audit log (cognitoSub is opaque,
        // cannot be stored in UUID column). Same pattern as revoke handler.
        const actorUser = await tx.user.findFirst({
          where: { cognitoSub: actorCognitoSub, tenantId },
          select: { id: true },
        });

        // Emit one audit row per dimension that actually changed.
        const auditRows: Array<{ action: string; metadata: object }> = [];
        if (body.role !== undefined && body.role !== target.role) {
          auditRows.push({
            action: 'user_role_changed',
            metadata: { from: target.role, to: body.role },
          });
        }
        if (body.locationId !== undefined && body.locationId !== target.locationId) {
          auditRows.push({
            action: 'user_location_changed',
            metadata: { from: target.locationId, to: body.locationId },
          });
        }
        if (body.status !== undefined && body.status !== target.status) {
          auditRows.push({
            action: 'user_status_changed',
            metadata: { from: target.status, to: body.status },
          });
        }
        for (const row of auditRows) {
          await tx.auditLog.create({
            data: {
              tenantId,
              actorType: 'user',
              actorId: actorUser?.id ?? null,
              action: row.action,
              entityType: 'user',
              entityId: targetId,
              metadata: row.metadata,
              ipAddress: request.ip,
            },
          });
        }

        return {
          user: updated,
          targetEmail: target.email,
          roleChanged: body.role !== undefined && body.role !== target.role,
          locationChanged: body.locationId !== undefined && body.locationId !== target.locationId,
        };
      });

      // Cognito sync — best-effort, outside the DB transaction.
      // Only syncs role and/or locationId (status has no Cognito attribute).
      // DB is the source of truth; Cognito reflects on next JWT refresh if this fails.
      if (result.roleChanged || result.locationChanged) {
        try {
          await updateOfficineUserRoleAndLocation({
            poolId: env.COGNITO_OFFICINE_POOL_ID,
            email: result.targetEmail,
            ...(result.roleChanged && body.role !== undefined ? { role: body.role } : {}),
            ...(result.locationChanged ? { locationId: body.locationId ?? null } : {}),
          });
        } catch (err) {
          request.log.error(
            { err, targetId },
            'cognito user attribute sync failed (DB updated; takes effect on next JWT refresh)',
          );
        }
      }

      return reply.code(200).send({ user: serializeUserAdmin(result.user) });
    },
  );
};
