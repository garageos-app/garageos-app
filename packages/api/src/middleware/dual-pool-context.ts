import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

import { clientiContext } from './clienti-context.js';
import { tenantContext } from './tenant-context.js';

// "Any User" auth chain helper for endpoints documented as cross-pool
// (APPENDICE_A §2.5 timeline, future §3.5 access-log). Branches on
// request.authPool to delegate to tenantContext or clientiContext.
// Must run after requireAuth — denies if authPool is missing.

function unauthorizedError(detail: string): FastifyError {
  const err = new Error(detail) as FastifyError;
  err.name = 'Unauthorized';
  err.statusCode = 401;
  return err;
}

export async function dualPoolContext(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.authPool === 'officine') {
    return tenantContext(request, reply);
  }
  if (request.authPool === 'clienti') {
    return clientiContext(request, reply);
  }
  throw unauthorizedError('Authentication required');
}
