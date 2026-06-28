// POST /v1/admin/tenants — Slice 1 platform-admin endpoint to provision a new
// Tenant with a primary Location and a super_admin Invitation.
//
// Decision notes:
// - Magic-link email sent via Resend (routed through ses-client.ts transport).
//   The plaintext token is used only to build the URL and is never returned in
//   the API response; only the SHA-256 hash lands in the invitation row.
// - actorType:'system' in the audit log because platform admins have no tenant
//   User row in the database — they exist only in the platform-admins Cognito
//   pool. The Cognito sub is captured in metadata for traceability.
// - Cognito pre-check (getOfficineUserByEmail) runs OUTSIDE the DB transaction
//   to avoid holding an open Postgres connection during a network call (P2028
//   risk — see feedback_cognito_call_outside_postgres_tx.md).
// - Auth chain: requireAuth → requirePlatformAdminsPool. No tenantContext
//   middleware and no rate-limit — platform admins are trusted internal staff.
//   A rate-limit may be added in a later slice.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { Prisma, VatNumberSchema } from '@garageos/database';
import { businessError } from '../../lib/business-error.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requirePlatformAdminsPool } from '../../middleware/require-platform-admins-pool.js';
import { getOfficineUserByEmail, CognitoUnavailableError } from '../../lib/cognito.js';
import { sendInvitationEmail } from '../../lib/ses-client.js';
import { createInternalInvitation } from '../../lib/invitation-creation.js';
import { env } from '../../config/env.js';

const WEB_BASE_URL = process.env.WEB_BASE_URL ?? 'https://app.garageos.aifollyadvisor.com';

// Presence / type / length validation only. Domain checks (VAT format,
// cross-tenant email collision) are done manually for precise error codes.
// Trim is applied BEFORE min(1) so that whitespace-only values are rejected
// rather than silently becoming empty strings after transformation.
const BodySchema = z.object({
  businessName: z.string().trim().min(1).max(200),
  vatNumber: z.string().trim().min(1).max(20),
  email: z.string().trim().toLowerCase().email().max(255),
  ownerFirstName: z.string().trim().min(1).max(100),
  ownerLastName: z.string().trim().min(1).max(100),
  ownerEmail: z.string().trim().toLowerCase().email().max(255),
});

export const adminTenantsCreateRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/v1/admin/tenants',
    {
      preHandler: [requireAuth, requirePlatformAdminsPool],
    },
    async (request, reply) => {
      const parsed = BodySchema.safeParse(request.body);
      if (!parsed.success) throw parsed.error;
      const body = parsed.data;

      // Manual VAT format check using the canonical VatNumberSchema from the
      // database package (packages/database/src/validators/common.ts).
      if (!VatNumberSchema.safeParse(body.vatNumber).success) {
        throw businessError(
          'tenant.vat_number_invalid',
          400,
          'P.IVA non valida: deve essere di 11 cifre.',
        );
      }

      // ─── Cognito pre-check (OUTSIDE tx) ─────────────────────────────────────
      // Cross-tenant early-check: if the owner email already exists in the
      // officine Cognito pool, it belongs to a user in another tenant.
      // Network calls must not hold an open Postgres transaction (P2028 risk).
      let cognitoUser;
      try {
        cognitoUser = await getOfficineUserByEmail({
          poolId: env.COGNITO_OFFICINE_POOL_ID,
          email: body.ownerEmail,
        });
      } catch (err) {
        if (err instanceof CognitoUnavailableError) {
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
          "Questa email è già registrata in un'altra officina. Usa un altro indirizzo o contatta il supporto.",
        );
      }

      // ─── DB pre-check: pending invitation in another tenant (OUTSIDE tx) ────
      // The Cognito check above catches emails that already ACCEPTED an invitation
      // (Cognito user exists). However, a PENDING (unaccepted) internal_user
      // invitation in ANOTHER tenant has no Cognito user yet — AdminCreateUser runs
      // only at acceptance time. The per-tenant partial unique index
      // uq_invitations_pending_internal never fires for a brand-new tenant, so
      // without this check two tenants can be provisioned for the same ownerEmail.
      // The second owner's magic-link acceptance would fail at AdminCreateUser,
      // orphaning that tenant. A residual concurrent TOCTOU window is accepted here
      // (same policy as the sibling invite endpoint) — no locking added by design.
      const pendingElsewhere = await app.withContext({ role: 'admin' as const }, (tx) =>
        tx.invitation.findFirst({
          where: {
            targetEmail: body.ownerEmail,
            invitationType: 'internal_user',
            acceptedAt: null,
            expiresAt: { gt: new Date() },
          },
          select: { id: true },
        }),
      );
      if (pendingElsewhere) {
        throw businessError(
          'user.invitation.email_in_other_tenant',
          409,
          'Questa email ha già un invito officina in sospeso. Usa un altro indirizzo o contatta il supporto.',
        );
      }

      // ─── DB transaction: tenant → location → invitation → audit ─────────────
      const txResult = await app.withContext({ role: 'admin' as const }, async (tx) => {
        // Step 1: create tenant. Rely on schema defaults for status /
        // billingStatus / plan. P2002 on vatNumber unique index → duplicate.
        let tenant;
        try {
          tenant = await tx.tenant.create({
            data: {
              businessName: body.businessName,
              vatNumber: body.vatNumber,
              email: body.email,
            },
            select: { id: true, businessName: true, vatNumber: true, status: true },
          });
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            throw businessError('tenant.vat_number_duplicate', 409, 'P.IVA già registrata.');
          }
          throw err;
        }

        // Step 2: create primary location with placeholder values. The workshop
        // owner fills in real address data during the onboarding wizard (F-OFF-003).
        // Placeholder values satisfy NOT NULL + VarChar length constraints only —
        // there are no CHECK constraints on these columns.
        const location = await tx.location.create({
          data: {
            tenantId: tenant.id,
            name: 'Sede principale',
            addressLine: 'Da definire',
            city: 'Da definire',
            province: 'NA',
            postalCode: '00100',
            country: 'IT',
            isPrimary: true,
          },
          select: { id: true },
        });

        // Step 3: generate token + insert invitation row. P2002 on the partial
        // unique index (same pattern as users-invitations-create.ts, BR-206) is
        // mapped to duplicate_pending inside createInternalInvitation.
        const { invitation, tokenPlaintext } = await createInternalInvitation(tx, {
          tenantId: tenant.id,
          targetEmail: body.ownerEmail,
          firstName: body.ownerFirstName,
          lastName: body.ownerLastName,
          role: 'super_admin',
          locationId: location.id,
        });

        // Step 4: audit log — same transaction so it rolls back atomically with
        // the rows above. actorType:'system' because platform admins have no
        // tenant User row; the Cognito sub is captured in metadata instead.
        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            actorType: 'system',
            actorId: null,
            action: 'tenant_created',
            entityType: 'tenant',
            entityId: tenant.id,
            metadata: {
              actorCognitoSub: request.jwt?.sub ?? null,
              ownerEmail: body.ownerEmail,
              vatNumber: body.vatNumber,
            },
            ipAddress: request.ip,
          },
        });

        // tokenPlaintext is returned to the outer scope to build the magic-link
        // URL; it never lands in a DB column beyond its hash, and never in the
        // HTTP response.
        return { tenant, invitation, tokenPlaintext };
      });

      const { tenant, invitation, tokenPlaintext } = txResult;

      // ─── Best-effort email (OUTSIDE tx) ─────────────────────────────────────
      // Same pattern as users-invitations-create.ts: failure logs and
      // continues — the DB rows are already committed. The invitation remains
      // valid; the operator can resend manually if needed.
      const jwt = request.jwt!;
      const adminName = [jwt.given_name, jwt.family_name].filter(Boolean).join(' ') || 'GarageOS';
      let emailSent = true;
      try {
        await sendInvitationEmail({
          toAddress: body.ownerEmail,
          invitedFirstName: body.ownerFirstName,
          invitedByName: adminName,
          tenantName: body.businessName,
          role: 'super_admin',
          magicLinkUrl: `${WEB_BASE_URL}/invitations/${tokenPlaintext}`,
        });
      } catch (err) {
        emailSent = false;
        request.log.error(
          { err, tenantId: tenant.id },
          'tenant invite email send failed (best-effort, tenant persisted)',
        );
      }

      return reply.code(201).send({
        tenant: {
          id: tenant.id,
          businessName: tenant.businessName,
          vatNumber: tenant.vatNumber,
          status: tenant.status,
        },
        invitation: {
          ownerEmail: body.ownerEmail,
          expiresAt: invitation.expiresAt,
          emailSent,
        },
      });
    },
  );
};
