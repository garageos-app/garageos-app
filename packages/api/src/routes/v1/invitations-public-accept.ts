// POST /v1/invitations/:token/accept — F-OFF-004 public invitation acceptance.
//
// Public endpoint (no JWT auth). The token IS the credential. The bearer
// claims their account by providing a password. Three Cognito phases follow
// the read/pre-flight phase to guarantee atomicity and clean rollback.
//
// Phase 1: Read invitation + pre-flight checks (no writes; anti-enum 404).
// Phase 2: Cognito AdminCreateUser SUPPRESS → extract cognitoSub.
// Phase 3: Cognito AdminSetUserPassword Permanent (rollback to AdminDeleteUser on failure).
// Phase 4: DB insert User + consume invitation + audit log (one transaction).
//
// See spec §4.5 and auth-signup.ts for the rollback pattern rationale.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { Prisma } from '@garageos/database';

import { env } from '../../config/env.js';
import { businessError } from '../../lib/business-error.js';
import {
  CognitoEmailAlreadyExistsError,
  CognitoInvalidPasswordError,
  createOfficineCognitoUser,
  deleteCognitoUser,
  setOfficineCognitoPassword,
} from '../../lib/cognito.js';
import { hashToken } from '../../lib/secure-tokens.js';
import {
  USER_ADMIN_SELECT,
  type UserAdminRow,
  serializeUserAdmin,
} from '../../lib/dtos/user-admin.js';

const ParamsSchema = z.object({ token: z.string().min(1).max(200) });
const BodySchema = z.object({ password: z.string().min(8).max(256) });

export const invitationsPublicAcceptRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/v1/invitations/:token/accept',
    {
      config: {
        // Public endpoint — rate-limit per source IP (per-IP default from
        // @fastify/rate-limit when no keyGenerator is specified). 5 attempts
        // per minute is generous enough for a legitimate user and tight
        // enough to slow credential-stuffing.
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
        },
      },
    },
    async (request, reply) => {
      const parsedParams = ParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        // Anti-enumeration: invalid param shape looks identical to "not found".
        throw businessError('user.invitation.not_found', 404, 'Invito non trovato.');
      }
      const parsedBody = BodySchema.safeParse(request.body);
      if (!parsedBody.success) throw parsedBody.error;

      // ─── Phase 1 — read invitation + pre-flight (no writes) ───────────────
      // Anti-enumeration: wrong type / expired / consumed all return 404
      // so callers cannot distinguish between them.
      const invitation = await app.withContext({ role: 'admin' as const }, async (tx) => {
        const inv = await tx.invitation.findUnique({
          where: { tokenHash: hashToken(parsedParams.data.token) },
          select: {
            id: true,
            tenantId: true,
            invitationType: true,
            targetEmail: true,
            firstName: true,
            lastName: true,
            role: true,
            locationId: true,
            acceptedAt: true,
            expiresAt: true,
          },
        });

        if (
          !inv ||
          inv.invitationType !== 'internal_user' ||
          inv.acceptedAt !== null ||
          inv.expiresAt < new Date()
        ) {
          throw businessError('user.invitation.not_found', 404, 'Invito non trovato.');
        }

        // Email collision pre-check — best-effort, not race-proof. The User
        // schema has @unique on cognitoSub (not on (tenantId, email)), so the
        // hard safety net is in Phase 4 where the User.create can fail with
        // P2002 on cognitoSub if a Cognito user with the same email already
        // existed and a parallel accept got there first. Phase 4 catches that
        // and rolls back the just-created Cognito user.
        const existingUser = await tx.user.findFirst({
          where: { tenantId: inv.tenantId, email: inv.targetEmail, deletedAt: null },
          select: { id: true },
        });
        if (existingUser) {
          throw businessError(
            'user.invitation.email_already_active',
            409,
            'Un account con questa email esiste già nel sistema. Effettua il login.',
          );
        }

        return inv;
      });

      const poolId = env.COGNITO_OFFICINE_POOL_ID;

      // ─── Phase 2 — Cognito AdminCreateUser ────────────────────────────────
      let cognitoSub: string;
      try {
        const created = await createOfficineCognitoUser({
          poolId,
          email: invitation.targetEmail,
          firstName: invitation.firstName ?? '',
          lastName: invitation.lastName ?? '',
          tenantId: invitation.tenantId,
          // role is non-null for internal_user invitations (validated at invite creation).
          role: invitation.role!,
          locationId: invitation.locationId,
        });
        cognitoSub = created.cognitoSub;
      } catch (err) {
        if (err instanceof CognitoEmailAlreadyExistsError) {
          // Another concurrent accept or out-of-band Cognito creation.
          throw businessError(
            'user.invitation.email_already_active',
            409,
            'Un account con questa email esiste già nel sistema.',
          );
        }
        throw businessError(
          'user.invitation.cognito_unavailable',
          502,
          'Servizio di autenticazione temporaneamente non disponibile.',
        );
      }

      // ─── Phase 3 — Cognito AdminSetUserPassword (with rollback) ───────────
      // If setting the permanent password fails we must delete the just-created
      // Cognito user — leaving it in FORCE_CHANGE_PASSWORD with no known
      // credential would lock the user out permanently. Mirror auth-signup.ts
      // §Phase 2 rollback pattern.
      try {
        await setOfficineCognitoPassword({
          poolId,
          email: invitation.targetEmail,
          password: parsedBody.data.password,
        });
      } catch (err) {
        request.log.warn(
          { invitationId: invitation.id, email: invitation.targetEmail },
          'rolling back Cognito user (password phase failed)',
        );
        await deleteCognitoUser({ poolId, email: invitation.targetEmail }).catch((rbErr) => {
          // Rollback failure is logged but not re-thrown: the invitation is not
          // consumed so the user can retry. Operator runbook must clean up
          // orphaned Cognito users via the AdminDeleteUser console action.
          request.log.error(
            { err: rbErr, invitationId: invitation.id },
            'cognito rollback failed — operator must clean up orphaned Cognito user',
          );
        });
        if (err instanceof CognitoInvalidPasswordError) {
          throw businessError(
            'user.invitation.accept_password_policy',
            422,
            'La password non rispetta i requisiti del sistema.',
          );
        }
        throw businessError(
          'user.invitation.cognito_unavailable',
          502,
          'Servizio di autenticazione temporaneamente non disponibile.',
        );
      }

      // ─── Phase 4 — DB: insert User + consume invitation + audit log ────────
      // Single transaction so all three writes succeed or none do.
      // P2002 on User.create means a parallel accept already committed a User
      // with the same cognitoSub — roll back our freshly-created Cognito user
      // and surface the conflict to the caller.
      let newUser: UserAdminRow;
      try {
        newUser = await app.withContext({ role: 'admin' as const }, async (tx) => {
          const created = await tx.user.create({
            data: {
              tenantId: invitation.tenantId,
              cognitoSub,
              email: invitation.targetEmail,
              firstName: invitation.firstName ?? '',
              lastName: invitation.lastName ?? '',
              role: invitation.role!,
              locationId: invitation.locationId,
              status: 'active',
            },
            select: USER_ADMIN_SELECT,
          });

          await tx.invitation.update({
            where: { id: invitation.id },
            data: { acceptedAt: new Date() },
          });

          // actorId is the new User's UUID (not cognitoSub) — the user accepting
          // their own invitation is semantically the actor, and actorId is a
          // UUID column. See plan §9 adaptation note on actorId.
          await tx.auditLog.create({
            data: {
              tenantId: invitation.tenantId,
              actorType: 'user',
              actorId: created.id,
              action: 'user_invitation_accepted',
              entityType: 'user',
              entityId: created.id,
              metadata: { invitationId: invitation.id, role: invitation.role },
              ipAddress: request.ip,
            },
          });

          return created;
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          // A parallel accept created a User with the same cognitoSub — roll
          // back the Cognito user we just created to avoid leaving an orphan.
          request.log.warn(
            { invitationId: invitation.id, target: 'phase4 race' },
            'phase 4 user race detected — rolling back cognito',
          );
          await deleteCognitoUser({ poolId, email: invitation.targetEmail }).catch((rbErr) => {
            request.log.error(
              { err: rbErr, invitationId: invitation.id },
              'cognito rollback failed after phase 4 race — operator must clean up',
            );
          });
          throw businessError(
            'user.invitation.email_already_active',
            409,
            'Un account con questa email esiste già nel sistema. Effettua il login.',
          );
        }
        throw err;
      }

      // JWT auto-login is deferred per spec §4.5 annotation: the web client
      // performs a separate login call after receiving 201. Return user only.
      return reply.code(201).send({ user: serializeUserAdmin(newUser) });
    },
  );
};
