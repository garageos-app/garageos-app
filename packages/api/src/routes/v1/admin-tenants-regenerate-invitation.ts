// POST /v1/admin/tenants/:id/regenerate-invitation — Slice 2 platform-admin
// endpoint to mint a fresh magic-link token on an existing pending owner
// invitation (in-place UPDATE, NOT a new row).
//
// This is the operator recovery path for "email never arrived / link expired".
//
// *** IMPORTANT: this is the ONLY response in the GarageOS system that returns
// a plaintext invitation token. This is intentional — the caller is an
// authenticated platform admin performing an explicit recovery action. The token
// is used by the admin to hand the magic-link directly to the workshop owner
// through a secondary channel when the email transport fails. ***
//
// Design notes:
//   - In-place UPDATE: the invitation row is reused (same id, same targetEmail,
//     same role). Only tokenHash + expiresAt are overwritten, making the old
//     token dead instantly. A new row would break the partial unique index
//     uq_invitations_pending_internal and leave stale orphan rows.
//   - No updatedAt column on Invitation — do NOT set it. The Slice-1 CI failure
//     was caused by an invented `invitations.updated_at` column.
//   - status check: BR-210 — a suspended/cancelled tenant must not onboard.
//     The same guard exists on the accept endpoint; we mirror it here.
//   - Auth chain: requireAuth → requirePlatformAdminsPool. Rate-limit: 30 calls
//     per hour per platform-admin sub — see adminTenantRateLimitConfig.
//   - actorType:'system' in audit log — platform admins have no tenant User row;
//     Cognito sub captured in metadata instead.
//   - Best-effort email (mirror Slice 1): failure logs and continues; the
//     plaintext magicLinkUrl in the response is the operator's fallback.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { businessError } from '../../lib/business-error.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requirePlatformAdminsPool } from '../../middleware/require-platform-admins-pool.js';
import { sendInvitationEmail } from '../../lib/ses-client.js';
import { generateInvitationToken } from '../../lib/secure-tokens.js';
import { INVITATION_TTL_MS } from '../../lib/invitation-creation.js';
import { adminTenantRateLimitConfig } from '../../lib/admin-tenant-rate-limit.js';

const WEB_BASE_URL = process.env.WEB_BASE_URL ?? 'https://app.garageos.aifollyadvisor.com';

const ParamsSchema = z.object({ id: z.string().uuid() });

export const adminTenantsRegenerateInvitationRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/v1/admin/tenants/:id/regenerate-invitation',
    {
      preHandler: [requireAuth, requirePlatformAdminsPool],
      config: { rateLimit: adminTenantRateLimitConfig },
    },
    async (request, reply) => {
      // Anti-enum: invalid UUID format → 404, same as unknown tenant.
      const parsedParams = ParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        throw businessError('tenant.not_found', 404, 'Officina non trovata.');
      }
      const { id } = parsedParams.data;

      // ─── DB transaction: validate → find invitation → update token → audit ──
      const txResult = await app.withContext({ role: 'admin' as const }, async (tx) => {
        // Step 1: load tenant — null (unknown id) or soft-deleted → 404.
        const tenant = await tx.tenant.findFirst({
          where: { id, deletedAt: null },
          select: { id: true, status: true, businessName: true },
        });
        if (!tenant) {
          throw businessError('tenant.not_found', 404, 'Officina non trovata.');
        }

        // Step 2: BR-210 — a suspended or cancelled tenant must not onboard.
        // Mirror the same guard in invitations-public-accept.ts Phase 1.
        // See BR-210 in docs/APPENDICE_F_BUSINESS_LOGIC.md.
        if (tenant.status !== 'active') {
          throw businessError(
            'tenant.invalid_status',
            409,
            "L'officina non è in uno stato che permette la rigenerazione dell'invito.",
          );
        }

        // Step 3: find the most-recent owner invitation for this tenant.
        // orderBy createdAt desc picks the latest if somehow multiple rows exist.
        const invitation = await tx.invitation.findFirst({
          where: {
            tenantId: id,
            invitationType: 'internal_user',
            role: 'super_admin',
          },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            targetEmail: true,
            firstName: true,
            lastName: true,
            acceptedAt: true,
          },
        });

        if (!invitation) {
          // Legacy tenant provisioned before Slice 1 — no invitation row exists.
          throw businessError(
            'user.invitation.not_found',
            404,
            'Nessun invito da rigenerare per questa officina.',
          );
        }

        if (invitation.acceptedAt !== null) {
          // Owner already accepted — regenerating is pointless; use a dedicated
          // user-invite flow to add a new user if needed.
          throw businessError(
            'user.invitation.already_accepted',
            410,
            "L'invito è già stato accettato.",
          );
        }

        // Step 4: mint fresh token + overwrite hash/expiry in-place.
        // The old tokenHash is overwritten → the old magic-link URL becomes dead
        // immediately (findUnique on the old hash will return null).
        // IMPORTANT: Invitation has NO updatedAt column — do NOT set it.
        const { plaintext, hash } = generateInvitationToken();
        const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

        await tx.invitation.update({
          where: { id: invitation.id },
          data: { tokenHash: hash, expiresAt },
        });

        // Step 5: audit log — same transaction so it rolls back atomically on failure.
        await tx.auditLog.create({
          data: {
            tenantId: id,
            actorType: 'system',
            actorId: null,
            action: 'tenant_invitation_regenerated',
            entityType: 'invitation',
            entityId: invitation.id,
            metadata: {
              actorCognitoSub: request.jwt?.sub ?? null,
              ownerEmail: invitation.targetEmail,
            },
            ipAddress: request.ip,
          },
        });

        return {
          invitation: {
            id: invitation.id,
            targetEmail: invitation.targetEmail,
            firstName: invitation.firstName,
            lastName: invitation.lastName,
          },
          tenant: { businessName: tenant.businessName },
          tokenPlaintext: plaintext,
          expiresAt,
        };
      });

      const { invitation, tenant, tokenPlaintext, expiresAt } = txResult;

      // ─── Best-effort email (OUTSIDE tx) ─────────────────────────────────────
      // Mirror admin-tenants-create.ts: failure logs and continues — the DB row
      // is already committed with the new hash. The plaintext magicLinkUrl in
      // the response is the operator's fallback channel.
      const jwt = request.jwt!;
      const adminName = [jwt.given_name, jwt.family_name].filter(Boolean).join(' ') || 'GarageOS';
      const magicLinkUrl = `${WEB_BASE_URL}/invitations/${tokenPlaintext}`;

      let emailSent = true;
      try {
        await sendInvitationEmail({
          toAddress: invitation.targetEmail,
          invitedFirstName: invitation.firstName ?? '',
          invitedByName: adminName,
          tenantName: tenant.businessName,
          role: 'super_admin',
          magicLinkUrl,
        });
      } catch (err) {
        emailSent = false;
        request.log.error(
          { err, tenantId: id, invitationId: invitation.id },
          'regenerate-invitation email send failed (best-effort, token committed)',
        );
      }

      return reply.code(200).send({
        invitation: {
          ownerEmail: invitation.targetEmail,
          expiresAt: expiresAt.toISOString(),
          emailSent,
          // This is the ONLY response in GarageOS that returns a plaintext token.
          // Intentional: authenticated platform-admin explicit recovery action.
          magicLinkUrl,
        },
      });
    },
  );
};
