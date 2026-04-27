import type { FastifyError } from 'fastify';

// Problem+JSON factory with a specific machine code. Used for business-
// rule failures the shared error handler cannot infer from the exception
// shape (it maps P2025 → 404 and ZodError → 400; domain codes need an
// explicit path).
export function businessError(code: string, status: number, detail: string): FastifyError {
  const err = new Error(detail) as FastifyError;
  err.name = code;
  err.statusCode = status;
  return err;
}
