// POST /v1/admin/tenants/:id/users/invitations — Slice 3 platform-admin endpoint
// to invite a new staff user (mechanic) or owner (super_admin) into any existing
// tenant, returning and emailing a magic-link.
//
// Decision notes:
// - Mirrors admin-tenants-create.ts for the Cognito/pending pre-checks and
//   best-effort email pattern. Key difference: operates on an EXISTING tenant
//   (path :id, 404 if absent) rather than provisioning a new one.
// - actorType:'system' in the audit log — platform admins exist only in the
//   platform-admins Cognito pool; their sub is captured in metadata for
//   traceability. See admin-tenants-create.ts for the original rationale.
// - Cognito pre-check (getOfficineUserByEmail) runs OUTSIDE the DB transaction
//   to avoid holding an open Postgres connection during a network call (P2028
//   risk — see feedback_cognito_call_outside_postgres_tx.md).
// - mechanic role: locationId defaults to the tenant's primary active location
//   (BR-204 defaulting). If none exists → 422 user.location_required_for_mechanic.
// - super_admin role: locationId = null (owner-level role, not location-specific).
// - The plaintext token appears ONLY in the response magicLinkUrl — it is never
//   stored in the DB (only the SHA-256 hash lands in invitation.tokenHash), never
//   logged, and never placed in the audit metadata. See SECURITY note below.
// - Auth chain: requireAuth → requirePlatformAdminsPool. No tenantContext
//   middleware. Rate-limit: 30 calls per hour per platform-admin sub — see
//   adminTenantRateLimitConfig in lib/admin-tenant-rate-limit.ts.
// - Invite is allowed regardless of tenant.status (no status gate) — simplest
//   design, matches the plan (see brief).

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { businessError } from '../../lib/business-error.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requirePlatformAdminsPool } from '../../middleware/require-platform-admins-pool.js';
import { getOfficineUserByEmail, CognitoUnavailableError } from '../../lib/cognito.js';
import { sendInvitationEmail } from '../../lib/ses-client.js';
import { createInternalInvitation } from '../../lib/invitation-creation.js';
import { env } from '../../config/env.js';
import { adminTenantRateLimitConfig } from '../../lib/admin-tenant-rate-limit.js';

const WEB_BASE_URL = process.env.WEB_BASE_URL ?? 'https://app.garageos.aifollyadvisor.com';

// Anti-enum: invalid UUID format for :id → tenant.not_found 404,
// same as an unknown (valid) UUID. Prevents enumeration via error-code
// differences between format-invalid and truly-absent IDs.
const ParamsSchema = z.object({ id: z.string().uuid() });

// Presence / type / length validation only. Trim is applied BEFORE min(1) so
// that whitespace-only strings are rejected (not silently emptied after trim).
const BodySchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  role: z.enum(['super_admin', 'mechanic']),
});

export const adminTenantUsersInvitationsRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/v1/admin/tenants/:id/users/invitations',
    {
      preHandler: [requireAuth, requirePlatformAdminsPool],
      config: { rateLimit: adminTenantRateLimitConfig },
    },
    async (request, reply) => {
      // Anti-enum: invalid UUID format → 404 (same as unknown UUID).
      const parsedParams = ParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        throw businessError('tenant.not_found', 404, 'Officina non trovata.');
      }
      const { id } = parsedParams.data;

      const parsedBody = BodySchema.safeParse(request.body);
      if (!parsedBody.success) throw parsedBody.error;
      const { email, firstName, lastName, role } = parsedBody.data;

      // ─── Load tenant (OUTSIDE tx — no mutation, just a read) ────────────────
      // Invite is allowed regardless of tenant.status (no status gate by design).
      // businessName fetched here for the invitation email template.
      const tenant = await app.withContext({ role: 'admin' as const }, (tx) =>
        tx.tenant.findFirst({
          where: { id, deletedAt: null },
          select: { id: true, businessName: true },
        }),
      );
      if (!tenant) {
        throw businessError('tenant.not_found', 404, 'Officina non trovata.');
      }

      // ─── Same-tenant collision check (OUTSIDE tx) ────────────────────────────
      // Must run BEFORE the Cognito check: if the email already belongs to an
      // active or soft-deleted user IN THIS TENANT we return the tenant-specific
      // error code rather than email_in_other_tenant. The Cognito check below
      // then only catches genuinely cross-tenant cases (no DB row here but the
      // Cognito pool already has the user = registered in another workspace).
      // See Block 1 in users-invitations-create.ts for the original pattern.
      const existingUser = await app.withContext({ role: 'admin' as const }, (tx) =>
        tx.user.findFirst({
          where: { tenantId: id, email },
          select: { id: true, deletedAt: true },
        }),
      );
      if (existingUser) {
        if (existingUser.deletedAt !== null) {
          throw businessError(
            'user.invitation.email_soft_deleted_in_tenant',
            409,
            'Questa email appartiene a un utente disattivato di questa officina. Riattivalo dalla scheda utenti invece di reinvitarlo.',
          );
        }
        throw businessError(
          'user.invitation.email_already_active',
          409,
          'Questa email è già un utente attivo di questa officina.',
        );
      }

      // ─── Cognito pre-check (OUTSIDE tx) ──────────────────────────────────────
      // Cross-tenant early-check: if the email already exists in the officine
      // Cognito pool, it belongs to a user in another tenant — their Cognito
      // account was created at invitation-acceptance time, so existence here
      // means the user already belongs to another workspace.
      // Network calls must not hold an open Postgres transaction (P2028 risk).
      let cognitoUser;
      try {
        cognitoUser = await getOfficineUserByEmail({
          poolId: env.COGNITO_OFFICINE_POOL_ID,
          email,
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

      // ─── DB pre-check: pending invitation in ANOTHER tenant (OUTSIDE tx) ──────
      // A PENDING (unaccepted) internal_user invitation in ANOTHER tenant has no
      // Cognito user yet — AdminCreateUser runs only at acceptance time. The
      // per-tenant partial unique index uq_invitations_pending_internal never
      // fires for cross-tenant collisions, so without this check two tenants
      // can hold a live magic-link for the same email simultaneously. A residual
      // concurrent TOCTOU window is accepted (same policy as admin-tenants-create.ts).
      // tenantId: { not: id } ensures same-tenant duplicates fall through to
      // createInternalInvitation, which raises user.invitation.duplicate_pending 409
      // via P2002 on uq_invitations_pending_internal (BR-206). Without the exclusion,
      // a same-tenant re-invite would wrongly return email_in_other_tenant 409.
      const pendingElsewhere = await app.withContext({ role: 'admin' as const }, (tx) =>
        tx.invitation.findFirst({
          where: {
            targetEmail: email,
            invitationType: 'internal_user',
            acceptedAt: null,
            expiresAt: { gt: new Date() },
            tenantId: { not: id },
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

      // ─── DB transaction: resolve location + invitation + audit ───────────────
      const { invitation, tokenPlaintext } = await app.withContext(
        { role: 'admin' as const },
        async (tx) => {
          // Step 1: resolve locationId based on role.
          // mechanic — auto-default to the tenant's primary active location;
          //   422 if none exists (BR-204 mechanic-requires-location).
          // super_admin — owner-level role, not location-specific → null.
          let locationId: string | null = null;
          if (role === 'mechanic') {
            const primaryLocation = await tx.location.findFirst({
              where: { tenantId: id, isPrimary: true, status: 'active', deletedAt: null },
              select: { id: true },
            });
            if (!primaryLocation) {
              throw businessError(
                'user.location_required_for_mechanic',
                422,
                'Un meccanico deve essere assegnato a una sede.',
              );
            }
            locationId = primaryLocation.id;
          }

          // Step 2: generate token + insert invitation row.
          // createInternalInvitation maps P2002 on the partial unique index
          // uq_invitations_pending_internal → user.invitation.duplicate_pending 409
          // (BR-206 — no duplicate pending internal_user invitations per tenant+email).
          const result = await createInternalInvitation(tx, {
            tenantId: id,
            targetEmail: email,
            firstName,
            lastName,
            role,
            locationId,
          });

          // Step 3: audit log — same transaction so it rolls back atomically with
          // the invitation row above. actorType:'system' because platform admins
          // have no tenant User row; the Cognito sub is captured in metadata.
          // SECURITY: tokenPlaintext is intentionally EXCLUDED from metadata.
          await tx.auditLog.create({
            data: {
              tenantId: id,
              actorType: 'system',
              actorId: null,
              action: 'user_invited',
              entityType: 'user',
              entityId: result.invitation.id,
              metadata: {
                actorCognitoSub: request.jwt?.sub ?? null,
                role,
                targetEmail: email,
              },
              ipAddress: request.ip,
            },
          });

          return result;
        },
      );

      // ─── Best-effort email (OUTSIDE tx) ─────────────────────────────────────
      // DB rows are already committed. Email failure logs and continues — the
      // invitation remains valid; the operator can use the returned magicLinkUrl
      // as a fallback delivery channel.
      const jwt = request.jwt!;
      const adminName = [jwt.given_name, jwt.family_name].filter(Boolean).join(' ') || 'GarageOS';
      // SECURITY: tokenPlaintext is used only to build the URL returned to the
      // authenticated platform admin. It is never logged or placed in metadata.
      const magicLinkUrl = `${WEB_BASE_URL}/invitations/${tokenPlaintext}`;
      let emailSent = true;
      try {
        await sendInvitationEmail({
          toAddress: email,
          invitedFirstName: firstName,
          invitedByName: adminName,
          tenantName: tenant.businessName,
          role,
          magicLinkUrl,
        });
      } catch (err) {
        emailSent = false;
        request.log.error(
          { err, tenantId: id, invitationId: invitation.id },
          'user invite email send failed (best-effort, invitation persisted)',
        );
      }

      return reply.code(200).send({
        invitation: {
          email,
          role,
          expiresAt: invitation.expiresAt.toISOString(),
          emailSent,
          // This is the only response in GarageOS that returns a plaintext token
          // to the caller. Intentional: authenticated platform-admin explicit
          // invite action; the URL is shown once and never stored.
          magicLinkUrl,
        },
      });
    },
  );
};
