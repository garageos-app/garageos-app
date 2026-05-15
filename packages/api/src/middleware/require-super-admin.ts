import type { preHandlerHookHandler } from 'fastify';

// Role guard that gates routes to super_admin only. Must run after
// tenantContext, which populates request.userRole from the Cognito
// custom:role claim. Returns 403 with the auth.forbidden.super_admin_required
// code for any other role (today only 'mechanic'), defense-in-depth
// against client-side gating bugs.
export const requireSuperAdmin: preHandlerHookHandler = async (request, reply) => {
  if (request.userRole !== 'super_admin') {
    return reply.code(403).send({
      code: 'auth.forbidden.super_admin_required',
      message: 'Only Super Admin can perform this action',
    });
  }
};
