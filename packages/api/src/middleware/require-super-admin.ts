import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

// 403 with name="auth.forbidden.super_admin_required" so the shared
// error handler recognizes the dotted domain code (regex /[a-z]\.[a-z]/
// in error-handler.ts) and passes it through verbatim as the `code`
// field of the RFC 7807 Problem Details response. Same pattern as
// require-officina-pool.ts.
function forbiddenError(detail: string): FastifyError {
  const err = new Error(detail) as FastifyError;
  err.name = 'auth.forbidden.super_admin_required';
  err.statusCode = 403;
  return err;
}

// Role guard that gates routes to super_admin only. Must run after
// tenantContext, which populates request.userRole from the Cognito
// custom:role claim. Returns 403 with code
// auth.forbidden.super_admin_required for any other role (today only
// 'mechanic'), defense-in-depth against client-side gating bugs.
export async function requireSuperAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (request.userRole !== 'super_admin') {
    throw forbiddenError('Only Super Admin can perform this action');
  }
  void reply;
}
