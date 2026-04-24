import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

// Error shape with name="Unauthorized" (not "UnauthorizedError") so the
// shared error handler maps it to code=UNAUTHORIZED and title=Unauthorized —
// see src/plugins/error-handler.ts line 103 for the regex. Using
// @fastify/sensible's httpErrors.unauthorized() would yield the uglier
// UNAUTHORIZED_ERROR / "UnauthorizedError" pair.
function unauthorizedError(detail: string): FastifyError {
  const err = new Error(detail) as FastifyError;
  err.name = 'Unauthorized';
  err.statusCode = 401;
  return err;
}

// Header-based tenant-context extractor.
//
// STUB (PR 6): reads X-Tenant-ID and X-User-ID from the incoming
// request headers. This is explicitly a scaffolding shim — PR 7 will
// replace the body of this middleware with a Cognito / Supabase JWT
// verification step that derives the same two identifiers from verified
// claims. The shape of request.tenantId / request.userId and the 401
// behaviour are stable across that swap so downstream handlers written
// against this contract will not change.
//
// Zod 4 `z.uuid()` enforces RFC 4122. Tests supply hardcoded UUIDs with
// the v4 version nibble + variant bits; runtime callers generally use
// crypto.randomUUID() or real user IDs.

const headerSchema = z.object({
  'x-tenant-id': z.uuid(),
  'x-user-id': z.uuid(),
});

export async function tenantContext(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const parsed = headerSchema.safeParse({
    'x-tenant-id': request.headers['x-tenant-id'],
    'x-user-id': request.headers['x-user-id'],
  });

  if (!parsed.success) {
    // Shared error handler serialises this as RFC 7807 Problem Details
    // with type=UNAUTHORIZED and title=Unauthorized.
    throw unauthorizedError('Valid X-Tenant-ID and X-User-ID headers are required.');
  }

  request.tenantId = parsed.data['x-tenant-id'];
  request.userId = parsed.data['x-user-id'];

  // Explicitly suppress the `reply` unused-arg lint: Fastify passes it
  // because preHandler signatures accept it, but we do not respond here
  // directly (the thrown error goes through the shared handler).
  void reply;
}

declare module 'fastify' {
  interface FastifyRequest {
    tenantId?: string;
    userId?: string;
  }
}
