import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

// JWT-backed clienti-pool context extractor. Symmetric counterpart to
// tenantContext (officine) but consumes the customer-pool claim shape:
// `sub` (Cognito sub) and `custom:customer_id` (our DB customers.id),
// per APPENDICE_C §5.5 attribute mapping for the clienti pool. No
// `custom:tenant_id` / `custom:role` — customers are not scoped to a
// tenant and role is implicit ("customer").
//
// Must run after requireAuth — reads request.jwt populated by it. Pair
// with requireClientiPool upstream so officine-pool tokens never reach
// this middleware (their payload would not satisfy the clienti schema
// and the 401 here would be misleading).

const clientiClaimsSchema = z.object({
  sub: z.string().min(1),
  'custom:customer_id': z.uuid(),
});

function unauthorizedError(detail: string): FastifyError {
  const err = new Error(detail) as FastifyError;
  err.name = 'Unauthorized';
  err.statusCode = 401;
  return err;
}

export async function clientiContext(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.jwt) {
    throw unauthorizedError('Authentication required');
  }

  const parsed = clientiClaimsSchema.safeParse(request.jwt);
  if (!parsed.success) {
    request.log.warn(
      { issues: parsed.error.issues },
      'clienti-context: clienti claims validation failed',
    );
    throw unauthorizedError('Invalid customer claims in token');
  }

  // userId stays the Cognito sub (same convention as officine — see the
  // header comment in tenant-context.ts). customerId is the trusted DB
  // primary key from the JWT custom claim, set during signup when the
  // Customer row is created.
  request.userId = parsed.data.sub;
  request.customerId = parsed.data['custom:customer_id'];

  void reply;
}

declare module 'fastify' {
  interface FastifyRequest {
    customerId?: string;
  }
}
