import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

// 403 with name="Forbidden" so the shared error handler produces
// code=FORBIDDEN + title=Forbidden (see error-handler.ts line 103 for
// the CamelCase regex).
function forbiddenError(detail: string): FastifyError {
  const err = new Error(detail) as FastifyError;
  err.name = 'Forbidden';
  err.statusCode = 403;
  return err;
}

// preHandler guarding endpoints that only the platform-admins pool
// should reach. Must run after requireAuth — it reads request.authPool
// which requireAuth populates. If authPool is undefined (requireAuth
// missing from the chain or failed silently), this middleware denies
// the request; never let an unchecked request through just because the
// upstream state is odd.
//
// Used by /v1/admin/* routes. Platform admins have no tenant claims so
// no tenant-context dependency is needed here.
export async function requirePlatformAdminsPool(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (request.authPool !== 'platform-admins') {
    throw forbiddenError('This endpoint is restricted to platform administrators');
  }
  void reply;
}
