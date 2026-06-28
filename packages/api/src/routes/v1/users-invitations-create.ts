// POST /v1/users/invitations — F-OFF-004 Super Admin invitation endpoint.
//
// Creates an internal_user invitation row and sends a magic-link email via
// SES (best-effort). Implements:
//   BR-204: mechanic role requires a valid locationId
//   BR-206: partial unique index prevents duplicate pending internal_user
//           invitations for the same (tenant, email) pair
//
// Auth chain: requireAuth → requireOfficinaPool → tenantContext → requireSuperAdmin
// Rate limit: 10 per hour per tenant (prevents invitation spam).
//
// The plaintext token is used only to build the magic-link URL and is never
// returned in the API response — the serializer omits it by design.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { businessError } from '../../lib/business-error.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';
import { requireSuperAdmin } from '../../middleware/require-super-admin.js';
import { sendInvitationEmail } from '../../lib/ses-client.js';
import { createInternalInvitation } from '../../lib/invitation-creation.js';
import { serializeInvitationAdmin } from '../../lib/dtos/invitation.js';
import { getOfficineUserByEmail, CognitoUnavailableError } from '../../lib/cognito.js';
import { env } from '../../config/env.js';

const WEB_BASE_URL = process.env.WEB_BASE_URL ?? 'https://app.garageos.aifollyadvisor.com';

const InviteBodySchema = z.object({
  email: z
    .string()
    .email()
    .max(255)
    .transform((s) => s.trim().toLowerCase()),
  firstName: z
    .string()
    .min(1)
    .max(100)
    .transform((s) => s.trim()),
  lastName: z
    .string()
    .min(1)
    .max(100)
    .transform((s) => s.trim()),
  role: z.enum(['super_admin', 'mechanic']),
  locationId: z.string().uuid().nullable(),
});

export const usersInvitationsCreateRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/v1/users/invitations',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext, requireSuperAdmin],
      config: {
        rateLimit: {
          // 10 invitations per hour per tenant — generous for legitimate use,
          // prevents abuse of SES send quotas.
          max: 10,
          timeWindow: '1 hour',
          keyGenerator: (request) => `invite:${request.tenantId ?? request.ip}`,
        },
      },
    },
    async (request, reply) => {
      const parsed = InviteBodySchema.safeParse(request.body);
      if (!parsed.success) throw parsed.error;
      const body = parsed.data;

      // BR-204: mechanic role requires a location assignment.
      if (body.role === 'mechanic' && !body.locationId) {
        throw businessError(
          'user.location_required_for_mechanic',
          422,
          'Un meccanico deve essere assegnato a una sede.',
        );
      }

      const tenantId = request.tenantId!;
      // request.userId is the Cognito sub (opaque string) — see tenant-context.ts.
      const actorCognitoSub = request.userId!;

      // ─── Block 1 (DB tx): step 1 collision check only ───────────────────────
      // role: 'admin' bypasses RLS USING clauses that would deny writes to
      // tenants this transaction has no ownership relation to. Required pattern
      // per feedback_withcontext_empty_blocks_rls_writes.
      //
      // 1) DB collision check nel tenant corrente — INCLUDE soft-deleted.
      //    Discriminiamo a posteriori: active → email_already_active;
      //    soft-deleted → email_soft_deleted_in_tenant (operator deve usare
      //    POST /v1/users/:id/reactivate, non /invitations).
      //    See spec 2026-05-21-user-reactivation-design.md §4.2.
      const existingUser = await app.withContext({ role: 'admin' as const }, async (tx) => {
        return tx.user.findFirst({
          where: { tenantId, email: body.email },
          select: { id: true, deletedAt: true },
        });
      });

      if (existingUser) {
        if (existingUser.deletedAt !== null) {
          throw businessError(
            'user.invitation.email_soft_deleted_in_tenant',
            409,
            'Questa email appartiene a un utente disattivato. Riattivalo da Impostazioni → Utenti.',
          );
        }
        throw businessError(
          'user.invitation.email_already_active',
          409,
          'Un account con questa email esiste già nel sistema. Effettua il login.',
        );
      }

      // ─── Block 1bis (OUTSIDE tx): Cognito early-check ────────────────────────
      // Out-of-tx pattern mirrors users-admin-update.ts / users-admin-delete.ts /
      // auth-signup.ts — network call must not hold an open Postgres tx
      // (risks P2028 on slow Cognito).
      // TOCTOU between this read and the invitation.create below is already
      // covered by the P2002 partial unique index catch in block 2.
      //
      // 1bis) Cross-tenant early-check via Cognito.
      // Email assente in DB tenant corrente; hit Cognito = utente in altro tenant.
      // (Pool Officine è single-pool: email è alias globale.)
      let cognitoUser;
      try {
        cognitoUser = await getOfficineUserByEmail({
          poolId: env.COGNITO_OFFICINE_POOL_ID,
          email: body.email,
        });
      } catch (err) {
        if (err instanceof CognitoUnavailableError) {
          request.log.error({ err }, 'cognito lookup failed at invitation create');
          throw businessError(
            'auth.cognito_unavailable',
            502,
            'Servizio di autenticazione temporaneamente non disponibile.',
          );
        }
        throw err;
      }
      if (cognitoUser.exists) {
        throw businessError(
          'user.invitation.email_in_other_tenant',
          409,
          "Questa email risulta già registrata in un'altra officina. Contatta il supporto.",
        );
      }

      // ─── Block 2 (DB tx): steps 2 (location) + 3 (token/invitation) + 4-5 (audit) ─
      const txResult = await app.withContext({ role: 'admin' as const }, async (tx) => {
        // 2) Optional: validate that locationId belongs to the caller's tenant.
        if (body.locationId) {
          const loc = await tx.location.findFirst({
            where: { id: body.locationId, tenantId, status: 'active', deletedAt: null },
            select: { id: true },
          });
          if (!loc) {
            throw businessError(
              'user.invitation.location_invalid',
              422,
              'Sede non valida o inattiva.',
            );
          }
        }

        // 3) Generate token + insert invitation row. P2002 on the partial
        //    unique index (uq_invitations_pending_internal, BR-206) is mapped
        //    to duplicate_pending inside createInternalInvitation.
        const { invitation, tokenPlaintext } = await createInternalInvitation(tx, {
          tenantId,
          targetEmail: body.email,
          firstName: body.firstName,
          lastName: body.lastName,
          role: body.role,
          locationId: body.locationId,
        });

        // 4) Look up the inviting user's DB UUID so the audit row is
        //    traceable to the Super Admin who triggered the action.
        //    actorCognitoSub is an opaque Cognito string, not a UUID —
        //    cannot be stored directly in the UUID audit_logs.actor_id column.
        const actorUser = await tx.user.findFirst({
          where: { cognitoSub: actorCognitoSub, tenantId },
          select: { id: true },
        });

        // 5) Audit log — same transaction so it rolls back atomically if
        //    the invitation insert had failed above (defensive ordering).
        await tx.auditLog.create({
          data: {
            tenantId,
            actorType: 'user',
            actorId: actorUser?.id ?? null,
            action: 'user_invitation_created',
            entityType: 'invitation',
            entityId: invitation.id,
            metadata: {
              actorCognitoSub,
              targetEmail: body.email,
              role: body.role,
              locationId: body.locationId,
            },
            ipAddress: request.ip,
          },
        });

        // tokenPlaintext is returned so the outer scope can build the
        // magic-link URL; it never lands in the DB row or the response.
        return { invitation, tokenPlaintext };
      });

      const { invitation: result, tokenPlaintext } = txResult;

      // ─── Best-effort SES send (outside DB tx) ────────────────────────────────
      // Same pattern as auth-signup.ts Phase 4: failure logs + continues,
      // DB row already persisted. Inviter name fetched with a separate admin
      // context query to avoid extending the tx.
      const [tenant, inviter] = await Promise.all([
        app
          .withContext({ role: 'admin' as const }, (tx) =>
            tx.tenant.findUnique({
              where: { id: tenantId },
              select: { businessName: true },
            }),
          )
          .catch(() => null),
        app
          .withContext({ role: 'admin' as const }, (tx) =>
            tx.user.findFirst({
              where: { cognitoSub: actorCognitoSub, tenantId },
              select: { firstName: true, lastName: true },
            }),
          )
          .catch(() => null),
      ]);

      try {
        await sendInvitationEmail({
          toAddress: body.email,
          invitedFirstName: body.firstName,
          invitedByName: inviter ? `${inviter.firstName} ${inviter.lastName}` : 'GarageOS',
          tenantName: tenant?.businessName ?? 'GarageOS',
          role: body.role,
          magicLinkUrl: `${WEB_BASE_URL}/invitations/${tokenPlaintext}`,
        });
      } catch (err) {
        request.log.error(
          { err, invitationId: result.id },
          'invitation SES send failed (best-effort, row persisted)',
        );
      }

      // Plaintext token never leaves the SES email body; tokenHash is not in
      // INVITATION_ADMIN_SELECT, so no stripping needed.
      return reply.code(201).send({
        invitation: serializeInvitationAdmin(result),
      });
    },
  );
};
