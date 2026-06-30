// Helper: update a user's role or status within a tenant.
//
// Extracted from users-admin-update.ts so that both the officine super_admin
// route (PATCH /v1/users/:id) and the platform-admin cross-tenant
// route share the same business-invariant logic.
//
// Business rules enforced:
//   BR-203 — last super_admin guard: prevents the tenant from having zero
//             active super_admins by blocking demotion (role change) or
//             deactivation (status=inactive) of the last one.
//
// Error codes:
//   user.not_found                       — 404: target missing or cross-tenant
//   user.last_super_admin                — 409: BR-203 violation

import type { FastifyInstance, FastifyBaseLogger } from 'fastify';

import { env } from '../../config/env.js';
import { businessError } from '../business-error.js';
import {
  disableOfficineUser,
  enableOfficineUser,
  signOutOfficineUser,
  updateOfficineUserRoleAndLocation,
} from '../cognito.js';
import { USER_ADMIN_SELECT, serializeUserAdmin } from '../dtos/user-admin.js';
import type { UserAdminWireDto } from '../dtos/user-admin.js';

export type UpdateUserActor =
  | { type: 'user'; cognitoSub: string } // officine super_admin: audit actorType='user', actorId=DB uuid (looked up by {cognitoSub,tenantId})
  | { type: 'system'; cognitoSub: string }; // platform admin: audit actorType='system', actorId=null, metadata.actorCognitoSub=cognitoSub

export interface UpdateUserInput {
  tenantId: string;
  targetId: string;
  // Optional fields include `| undefined` to be compatible with Zod `.optional()` output
  // under the project's `exactOptionalPropertyTypes: true` tsconfig flag.
  body: {
    role?: 'super_admin' | 'mechanic' | undefined;
    status?: 'active' | 'inactive' | undefined;
  };
  actor: UpdateUserActor;
  ip: string;
}

export async function updateOfficineUser(
  app: FastifyInstance,
  input: UpdateUserInput,
  log: FastifyBaseLogger,
): Promise<UserAdminWireDto> {
  const { tenantId, targetId, body, actor } = input;

  const result = await app.withContext({ role: 'admin' as const }, async (tx) => {
    // Lookup target user (same tenant, not soft-deleted).
    const target = await tx.user.findFirst({
      where: { id: targetId, tenantId, deletedAt: null },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        cognitoSub: true,
      },
    });
    if (!target) {
      throw businessError('user.not_found', 404, 'Utente non trovato.');
    }

    // Compute effective new values.
    const newRole = body.role ?? target.role;
    const newStatus = body.status ?? target.status;

    // BR-203: race-safe guard against leaving the tenant with zero active
    // super_admins. Fires only when target IS currently an active super_admin
    // AND the new state would no longer be an active super_admin (either
    // role changed away from super_admin, or status changed to inactive).
    //
    // Lock ALL active super_admins in the tenant (INCLUDING the target).
    // Locking the disjoint set `id <> targetId` would let two concurrent
    // cross-demotes (Tx-A locks {B'}, Tx-B locks {A'}) proceed to UPDATE
    // and deadlock on cross-row locks at UPDATE time. Locking the FULL
    // set guarantees mutual exclusion: the second tx blocks at SELECT,
    // wakes up post-commit, sees the demoted peer, and hits the guard
    // correctly. Check is `length <= 1` because the only remaining row
    // may be the target itself. See BR-203.
    const isLosingAdmin =
      target.role === 'super_admin' &&
      target.status === 'active' &&
      (newRole !== 'super_admin' || newStatus !== 'active');

    if (isLosingAdmin) {
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

    // Persist — only include fields that were explicitly provided.
    const updated = await tx.user.update({
      where: { id: targetId },
      data: {
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
      },
      select: USER_ADMIN_SELECT,
    });

    // Look up actor's DB UUID for the audit log (only for 'user' actor type).
    // cognitoSub is opaque, cannot be stored in UUID column.
    // Same pattern as revoke handler.
    const actorUser =
      actor.type === 'user'
        ? await tx.user.findFirst({
            where: { cognitoSub: actor.cognitoSub, tenantId },
            select: { id: true },
          })
        : null;

    // For 'system' actor, include actorCognitoSub in each metadata row so the
    // platform admin is identifiable without a tenant User row. See UpdateUserActor.
    const actorMetaExtra = actor.type === 'system' ? { actorCognitoSub: actor.cognitoSub } : {};

    // Emit one audit row per dimension that actually changed.
    const auditRows: Array<{ action: string; metadata: object }> = [];
    if (body.role !== undefined && body.role !== target.role) {
      auditRows.push({
        action: 'user_role_changed',
        metadata: { from: target.role, to: body.role, ...actorMetaExtra },
      });
    }
    if (body.status !== undefined && body.status !== target.status) {
      auditRows.push({
        action: 'user_status_changed',
        metadata: { from: target.status, to: body.status, ...actorMetaExtra },
      });
    }
    for (const row of auditRows) {
      await tx.auditLog.create({
        data: {
          tenantId,
          actorType: actor.type,
          actorId: actor.type === 'user' ? (actorUser?.id ?? null) : null,
          action: row.action,
          entityType: 'user',
          entityId: targetId,
          metadata: row.metadata,
          ipAddress: input.ip,
        },
      });
    }

    return {
      user: updated,
      targetEmail: target.email,
      targetCognitoSub: target.cognitoSub,
      roleChanged: body.role !== undefined && body.role !== target.role,
      statusBecameInactive:
        body.status !== undefined && target.status === 'active' && body.status === 'inactive',
      // Symmetric with statusBecameInactive: inactive→active transition requires
      // re-enabling the Cognito account. See feedback_disabled_user_login_loop_ux
      // and feedback_lambda_iam_admin_enable_user_gap for the recurring class of
      // bugs that missing this symmetry causes.
      statusBecameActive:
        body.status !== undefined && target.status === 'inactive' && body.status === 'active',
    };
  });

  // Cognito sync — best-effort, outside the DB transaction.
  // Only syncs role (status has no Cognito attribute).
  // DB is the source of truth; Cognito reflects on next JWT refresh if this fails.
  if (result.roleChanged) {
    try {
      await updateOfficineUserRoleAndLocation({
        poolId: env.COGNITO_OFFICINE_POOL_ID,
        email: result.targetEmail,
        ...(body.role !== undefined ? { role: body.role } : {}),
      });
    } catch (err) {
      log.error(
        { err, targetId },
        'cognito user attribute sync failed (DB updated; takes effect on next JWT refresh)',
      );
    }
  }

  // Item 1 (PR1) + Item 5 (PR2) proactive: invalidate refresh tokens
  // AND disable the user on active→inactive transition. Same rationale
  // as users-admin-delete.ts — see that file for the comment.
  if (result.statusBecameInactive && result.targetCognitoSub) {
    try {
      await signOutOfficineUser({
        poolId: env.COGNITO_OFFICINE_POOL_ID,
        email: result.targetEmail,
      });
    } catch (err) {
      log.error(
        { err, targetId },
        'cognito global signout on status=inactive failed (DB updated; user retains access until access token TTL)',
      );
    }
    try {
      await disableOfficineUser({
        poolId: env.COGNITO_OFFICINE_POOL_ID,
        email: result.targetEmail,
      });
    } catch (err) {
      log.error(
        { err, targetId },
        'cognito user disable on status=inactive failed (DB updated; user may successfully re-login until next disable retry)',
      );
    }
  }

  // Symmetric enable: re-enable the Cognito account on inactive→active so the
  // user can log in again. Without this, AdminDisableUser set during deactivation
  // persists and the "Riattiva" flow leaves Cognito disabled → login loop.
  // See feedback_disabled_user_login_loop_ux / feedback_lambda_iam_admin_enable_user_gap.
  if (result.statusBecameActive) {
    try {
      await enableOfficineUser({
        poolId: env.COGNITO_OFFICINE_POOL_ID,
        email: result.targetEmail,
      });
    } catch (err) {
      log.error(
        { err, targetId },
        'cognito user enable on status=active failed (DB updated; user remains disabled in Cognito until next enable retry)',
      );
    }
  }

  return serializeUserAdmin(result.user);
}
