import type { FastifyRequest, FastifyReply } from 'fastify';

import { businessError } from '../lib/business-error.js';

// Gate admin-scoped routes on the Cognito claim `custom:role`.
// Reads `request.userRole` already populated by tenant-context.ts.
// Returns 403 with code `auth.forbidden.super_admin_required` for non-admins
// or chain misconfiguration (missing userRole). Introduced in slice L
// (PR #102) for PATCH /v1/tenants; F-OFF-004 reuses it for /v1/users routes.
export async function requireSuperAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (request.userRole !== 'super_admin') {
    throw businessError(
      'auth.forbidden.super_admin_required',
      403,
      'Operazione consentita solo agli amministratori.',
    );
  }
  void reply;
}
