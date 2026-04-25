import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

// Symmetric counterpart to requireOfficinaPool: rejects any request whose
// authPool is not 'clienti'. Used by /me/* routes (APPENDICE_A §3.5/§3.7)
// that target the customer-app side and must never be reachable by an
// officine-pool token — the JWT-issued tenant claims would be missing
// (`custom:customer_id` is absent) and the route would either error
// awkwardly or accidentally bypass ownership checks.
//
// Same defensive shape as the officine variant: when authPool is
// undefined (requireAuth missing or short-circuited), deny rather than
// trust the absence.
function forbiddenError(detail: string): FastifyError {
  const err = new Error(detail) as FastifyError;
  err.name = 'Forbidden';
  err.statusCode = 403;
  return err;
}

export async function requireClientiPool(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (request.authPool !== 'clienti') {
    throw forbiddenError('This endpoint is only available for customer users');
  }
  void reply;
}
