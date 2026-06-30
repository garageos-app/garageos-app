import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { businessError } from '../lib/business-error.js';
import type { CognitoIdTokenPayload } from '../plugins/auth.js';

// JWT-backed tenant context extractor (PR 7).
//
// Contract change from PR 6: `request.userId` is now the Cognito `sub`
// claim (VARCHAR(100) — opaque to us) rather than a DB-issued UUID.
// Handlers that need the database User.id must look it up via
//   prisma.user.findFirstOrThrow({
//     where: { cognitoSub: request.userId, tenantId: request.tenantId }
//   })
// (`tenantId` is the post-0004 application-layer guard — see
// packages/api/src/routes/v1/users.ts header for rationale.)
// This is intentional: moving the DB lookup out of the preHandler
// keeps hot paths single-query and lets handlers that do not need the
// DB row (e.g. pure auth checks) skip the round-trip entirely.
//
// Must run after requireAuth — reads request.jwt which requireAuth
// populates. Only valid for officine-pool tokens in PR 7; clienti-pool
// requests should be gated out by requireOfficinaPool before reaching
// this middleware. Claims shape reference: APPENDICE_C §5.5 (Cognito
// custom attributes) and GarageOS-Specifiche.md §5.5.2 / §7.3.

const officineClaimsSchema = z.object({
  sub: z.string().min(1),
  'custom:tenant_id': z.uuid(),
  'custom:role': z.enum(['super_admin', 'mechanic']),
});

export type UserRole = z.infer<typeof officineClaimsSchema>['custom:role'];

function unauthorizedError(detail: string): FastifyError {
  const err = new Error(detail) as FastifyError;
  err.name = 'Unauthorized';
  err.statusCode = 401;
  return err;
}

export async function tenantContext(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.jwt) {
    // Normally impossible: requireAuth must run before this middleware
    // and throws on missing / invalid tokens. Guard against chain
    // misconfiguration so a valid-looking request is never allowed
    // through with a blank tenant context.
    throw unauthorizedError('Authentication required');
  }

  const parsed = officineClaimsSchema.safeParse(request.jwt);
  if (!parsed.success) {
    request.log.warn(
      { issues: parsed.error.issues },
      'tenant-context: officine claims validation failed',
    );
    throw unauthorizedError('Invalid tenant claims in token');
  }

  request.userId = parsed.data.sub;
  request.tenantId = parsed.data['custom:tenant_id'];
  request.userRole = parsed.data['custom:role'];

  // F-OFF-004 follow-ups Item 1 (security regression closure):
  // Cognito access tokens remain valid until their TTL (~1h default)
  // even after a super_admin soft-deletes or sets status=inactive on the
  // user. Reactive DB lookup here makes the API surface the source of
  // truth — disabled/deleted users get 401 on the next request regardless
  // of access-token freshness.
  //
  // Companion proactive measure: users-admin-delete + users-admin-update
  // call AdminUserGlobalSignOut to invalidate refresh tokens.
  //
  // Status stays 401 to match existing JWT failures. The code, however, is
  // the dedicated `auth.session.inactive` (not the generic UNAUTHORIZED used
  // by require-auth / token failures): it is still GENERIC across "user
  // disabled" and "tenant suspended" (BR-210 — the client must not learn
  // which), but distinct enough that the web client renders a terminal
  // "accesso non disponibile" screen instead of looping the re-login a
  // plain expired-token UNAUTHORIZED would (correctly) trigger.
  const userRow = await request.server.prisma.user.findFirst({
    where: {
      cognitoSub: parsed.data.sub,
      tenantId: parsed.data['custom:tenant_id'],
      status: 'active',
      deletedAt: null,
      // BR-210: a suspended tenant must block all officine logins in a single
      // joined query with no extra round-trip. The null result from this filter
      // produces the same generic 401 as a disabled user (anti-enumeration:
      // the officine client must not distinguish "user disabled" from
      // "tenant suspended").
      tenant: { is: { status: 'active' } },
    },
    select: { id: true },
  });
  if (!userRow) {
    request.log.warn(
      { cognitoSub: parsed.data.sub, tenantId: parsed.data['custom:tenant_id'] },
      'tenant-context: user inactive or deleted — denying request',
    );
    // auth.session.inactive (APPENDICE_G §3.2) — see the comment block above.
    throw businessError('auth.session.inactive', 401, 'User inactive or not found');
  }

  void reply;
}

declare module 'fastify' {
  interface FastifyRequest {
    tenantId?: string;
    userId?: string;
    userRole?: UserRole;
  }
}

// Re-export to avoid a circular import in places that need the
// CognitoIdTokenPayload (e.g. future RBAC helpers built on top of the
// tenant context). Keeping the type alias local lets routes import
// from middleware without pulling in the full auth plugin surface.
export type { CognitoIdTokenPayload };
