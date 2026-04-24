import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { CognitoIdTokenPayload } from '../plugins/auth.js';

// JWT-backed tenant context extractor (PR 7).
//
// Contract change from PR 6: `request.userId` is now the Cognito `sub`
// claim (VARCHAR(100) — opaque to us) rather than a DB-issued UUID.
// Handlers that need the database User.id must look it up via
//   prisma.user.findUnique({ where: { cognitoSub: request.userId } })
// This is intentional: moving the DB lookup out of the preHandler
// keeps hot paths single-query and lets handlers that do not need the
// DB row (e.g. pure auth checks) skip the round-trip entirely.
//
// Must run after requireAuth — reads request.jwt which requireAuth
// populates. Only valid for officine-pool tokens in PR 7; clienti-pool
// requests should be gated out by requireOfficinaPool before reaching
// this middleware. Claims shape reference: APPENDICE_C §5.5 (Cognito
// custom attributes) and GarageOS-Specifiche.md §5.5.2 / §7.3.
//
// BR-204: `custom:location_id` is optional — super_admin accounts are
// not scoped to a specific location — so the schema tolerates its
// absence and leaves request.locationId undefined.

const officineClaimsSchema = z.object({
  sub: z.string().min(1),
  'custom:tenant_id': z.uuid(),
  'custom:role': z.enum(['super_admin', 'mechanic']),
  'custom:location_id': z.uuid().optional(),
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
  const loc = parsed.data['custom:location_id'];
  if (loc !== undefined) {
    request.locationId = loc;
  }

  void reply;
}

declare module 'fastify' {
  interface FastifyRequest {
    tenantId?: string;
    userId?: string;
    userRole?: UserRole;
    locationId?: string;
  }
}

// Re-export to avoid a circular import in places that need the
// CognitoIdTokenPayload (e.g. future RBAC helpers built on top of the
// tenant context). Keeping the type alias local lets routes import
// from middleware without pulling in the full auth plugin surface.
export type { CognitoIdTokenPayload };
