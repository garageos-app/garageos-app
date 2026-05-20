// GET /v1/invitations/:token — F-OFF-004 public pre-fill read.
//
// Called by the web AcceptInvitation page (no auth) to pre-fill the
// registration form. The token itself is the credential; exposing any
// invitation detail for invalid states would leak enumeration vectors,
// so all invalid cases (not found, wrong type, consumed, expired) return
// the same 404 + user.invitation.not_found code.
//
// Auth: none (no preHandler chain).
// DB context: app.withContext({ role: 'admin' }) — required because there
//   is no JWT-derived tenantId to scope the RLS row-filter (the request is
//   unauthenticated). See feedback_withcontext_empty_blocks_rls_writes.
//
// Wire shape: 7 public fields only. Internal fields (id, token, locationId,
//   acceptedAt, createdAt, tenantId) are intentionally stripped.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { businessError } from '../../lib/business-error.js';
import { hashToken } from '../../lib/secure-tokens.js';

const ParamsSchema = z.object({ token: z.string().min(1).max(200) });

export const invitationsPublicReadRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/invitations/:token', async (request, reply) => {
    const parsed = ParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      // Malformed token treated same as not-found (anti-enum).
      throw businessError('user.invitation.not_found', 404, 'Invito non trovato.');
    }

    const result = await app.withContext({ role: 'admin' as const }, async (tx) => {
      const inv = await tx.invitation.findUnique({
        where: { tokenHash: hashToken(parsed.data.token) },
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

      // Anti-enum: all invalid states collapse to the same 404.
      // See F-OFF-004 spec: not found / wrong type / consumed / expired.
      if (
        !inv ||
        inv.invitationType !== 'internal_user' ||
        inv.acceptedAt !== null ||
        inv.expiresAt < new Date()
      ) {
        throw businessError('user.invitation.not_found', 404, 'Invito non trovato.');
      }

      const [tenant, location] = await Promise.all([
        tx.tenant.findUnique({
          where: { id: inv.tenantId },
          // tenant.businessName is the display name (see adaptation: Tenant
          // model uses businessName, not name).
          select: { businessName: true },
        }),
        inv.locationId
          ? tx.location.findUnique({
              where: { id: inv.locationId },
              select: { name: true },
            })
          : Promise.resolve(null),
      ]);

      return {
        targetEmail: inv.targetEmail,
        firstName: inv.firstName ?? '',
        lastName: inv.lastName ?? '',
        role: inv.role ?? '',
        // Wire field is tenantName; value comes from tenant.businessName.
        tenantName: tenant?.businessName ?? '',
        locationName: location?.name ?? null,
        expiresAt: inv.expiresAt.toISOString(),
      };
    });

    return reply.code(200).send({ invitation: result });
  });
};
