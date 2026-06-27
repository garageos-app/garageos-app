import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

import type { AuthPool, CognitoIdTokenPayload } from '../plugins/auth.js';

// 401 with name="Unauthorized" so the shared error handler produces a
// clean code=UNAUTHORIZED via the CamelCase→SNAKE regex. See the same
// pattern comment in src/middleware/tenant-context.ts.
function unauthorizedError(detail: string): FastifyError {
  const err = new Error(detail) as FastifyError;
  err.name = 'Unauthorized';
  err.statusCode = 401;
  return err;
}

// preHandler that enforces a verified Cognito ID token is present on
// the request. On success it decorates:
//   - request.jwt       ← verified CognitoIdTokenPayload
//   - request.authPool  ← AuthPool ('officine' | 'clienti' | 'platform-admins')
// downstream handlers (tenantContext, requireOfficinaPool, routes) rely
// on these being set, so requireAuth must run before them in the
// preHandler chain.
//
// The body of this middleware intentionally never echoes the
// verifier's real failure message to the client: different failure
// modes (expired vs signature vs audience) look identical from
// outside. The actual reason is logged server-side at warn level so
// operators can still diagnose misconfigured pools.
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = request.headers.authorization;
  if (!header) {
    throw unauthorizedError('Missing Authorization header');
  }

  // Case-insensitive scheme match (RFC 7235 — token68 grammar is
  // case-insensitive for the scheme name).
  const match = /^bearer\s+(.+)$/i.exec(header);
  if (!match) {
    throw unauthorizedError('Authorization scheme must be Bearer');
  }
  const token = match[1]!.trim();
  if (!token) {
    throw unauthorizedError('Bearer token is empty');
  }

  let result: { pool: AuthPool; payload: CognitoIdTokenPayload };
  try {
    result = await request.server.jwtVerifier.verify(token);
  } catch (err) {
    request.log.warn({ err }, 'jwt verification failed');
    throw unauthorizedError('Invalid or expired token');
  }

  request.jwt = result.payload;
  request.authPool = result.pool;

  void reply;
}

declare module 'fastify' {
  interface FastifyRequest {
    jwt?: CognitoIdTokenPayload;
    authPool?: AuthPool;
  }
}
