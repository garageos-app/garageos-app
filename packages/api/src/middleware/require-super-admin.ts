import type { FastifyRequest, FastifyReply } from 'fastify';

import { businessError } from '../lib/business-error.js';

// F-OFF-004: gate admin-scoped routes on the Cognito claim `custom:role`.
// Reads `request.userRole` already populated by tenant-context.ts.
// Returns 403 with code `auth.forbidden.not_super_admin` for non-admins
// or chain misconfiguration (missing userRole).
export async function requireSuperAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (request.userRole !== 'super_admin') {
    throw businessError(
      'auth.forbidden.not_super_admin',
      403,
      'Operazione consentita solo agli amministratori.',
    );
  }
  void reply;
}
