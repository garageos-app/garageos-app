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

// preHandler guarding endpoints that only the officine pool (tenant
// users) should reach. Must run after requireAuth — it reads
// request.authPool which requireAuth populates. If authPool is
// undefined (requireAuth missing from the chain or failed silently),
// this middleware denies the request; never let an unchecked request
// through just because the upstream state is odd.
//
// In PR 7 every /v1/* route is gated this way because /v1/users/me
// and /v1/tenants/me are officine-only. The clienti-facing surface
// (/me/vehicles, /me/transfers, etc per APPENDICE_A §3.6 / §3.9)
// arrives in later PRs and will omit this guard or use the inverse.
export async function requireOfficinaPool(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (request.authPool !== 'officine') {
    throw forbiddenError('This endpoint is not available for customer users');
  }
  void reply;
}
