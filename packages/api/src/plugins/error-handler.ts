import { Prisma } from '@garageos/database';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

import { ERROR_TYPE_BASE_URL, PROBLEM_JSON_CONTENT_TYPE } from '../config/constants.js';

// Error handler that serialises every failure as RFC 7807 Problem
// Details (application/problem+json). See APPENDICE_A §4.1 for the
// canonical schema — clients across web / mobile / internal tooling
// parse this shape.
//
// Design notes:
// - Validation errors (Fastify schema) become 400 VALIDATION_ERROR with
//   a per-field `errors[]` breakdown.
// - Errors produced by @fastify/sensible (reply.httpErrors.notFound(),
//   etc.) carry their own statusCode/name/message and pass through.
// - Anything unhandled becomes 500 INTERNAL_SERVER_ERROR; we log the
//   original error server-side and omit stack traces from the response.

interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: string;
  detail: string;
  instance: string;
  request_id: string;
  errors?: Array<{ field: string; code: string; message: string }>;
}

interface FastifyValidationError {
  instancePath?: string;
  keyword?: string;
  message?: string;
  params?: Record<string, unknown>;
}

function buildProblem(
  request: FastifyRequest,
  code: string,
  title: string,
  status: number,
  detail: string,
): ProblemDetails {
  return {
    type: ERROR_TYPE_BASE_URL + code,
    title,
    status,
    code,
    detail,
    instance: request.url,
    request_id: request.id,
  };
}

function sendProblem(reply: FastifyReply, problem: ProblemDetails): FastifyReply {
  return reply.type(PROBLEM_JSON_CONTENT_TYPE).status(problem.status).send(problem);
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    const problem = buildProblem(
      request,
      'NOT_FOUND',
      'Resource not found',
      404,
      `Route ${request.method} ${request.url} does not exist.`,
    );
    return sendProblem(reply, problem);
  });

  app.setErrorHandler<FastifyError>((error, request, reply) => {
    // Fastify sets `validation` when a route schema rejects the input.
    if (error.validation) {
      const problem: ProblemDetails = {
        ...buildProblem(
          request,
          'VALIDATION_ERROR',
          'Request validation failed',
          400,
          error.message,
        ),
        errors: (error.validation as FastifyValidationError[]).map((v) => ({
          field: v.instancePath?.replace(/^\//, '') ?? '',
          code: v.keyword ?? 'invalid',
          message: v.message ?? 'Invalid value',
        })),
      };
      return sendProblem(reply, problem);
    }

    // Zod .parse() called inside a handler (query/params validation
    // where a full Fastify schema is overkill) throws ZodError. Treat
    // it exactly like a Fastify route-schema validation failure — same
    // VALIDATION_ERROR code, 400 status, per-field errors[] — so API
    // consumers see one consistent validation error shape.
    if (error instanceof ZodError) {
      const problem: ProblemDetails = {
        ...buildProblem(
          request,
          'VALIDATION_ERROR',
          'Request validation failed',
          400,
          error.issues[0]?.message ?? 'Invalid request',
        ),
        errors: error.issues.map((issue) => ({
          field: issue.path.join('.'),
          code: issue.code,
          message: issue.message,
        })),
      };
      return sendProblem(reply, problem);
    }

    // Prisma findUniqueOrThrow / findFirstOrThrow / update-on-missing
    // raise P2025. Surface it as a clean 404 so clients don't see a
    // generic 500 when a row legitimately does not exist (either
    // soft-deleted or hidden by the RLS policies active in the tx).
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      const problem = buildProblem(
        request,
        'NOT_FOUND',
        'Resource not found',
        404,
        'The requested resource does not exist or is not accessible.',
      );
      return sendProblem(reply, problem);
    }

    const status = error.statusCode ?? 500;

    if (status >= 500) {
      // Two paths for 5xx:
      // - Dot-separated domain code (e.g. 'auth.signup.cognito_unavailable')
      //   → pass through verbatim. Caller deliberately chose a 5xx domain
      //   error to signal a known-but-recoverable upstream condition (e.g.
      //   502 from a Cognito throttle). Mirrors the 4xx domain-code path.
      // - Anything else (generic Error, framework errors)
      //   → strip to opaque INTERNAL_SERVER_ERROR. Don't leak internals.
      const rawName = error.name || 'ERROR';
      if (/[a-z]\.[a-z]/.test(rawName)) {
        request.log.warn({ err: error, code: rawName, status }, 'domain-coded 5xx error');
        const problem = buildProblem(
          request,
          rawName,
          error.name || 'Error',
          status,
          error.message,
        );
        return sendProblem(reply, problem);
      }
      request.log.error({ err: error }, 'unhandled error');
      const problem = buildProblem(
        request,
        'INTERNAL_SERVER_ERROR',
        'Internal server error',
        500,
        'An unexpected error occurred. Please retry later.',
      );
      return sendProblem(reply, problem);
    }

    // 4xx from @fastify/sensible or route code (httpErrors.*). Two
    // naming styles are supported:
    //   - HttpError classes use PascalCase (Unauthorized, Conflict).
    //     Convert to SCREAMING_SNAKE_CASE (Unauthorized → UNAUTHORIZED).
    //   - Domain errors throw with a dot-separated machine code already
    //     (e.g. "vehicle.creation.duplicate_vin") — pass through as-is.
    const rawName = error.name || 'ERROR';
    const code = /[a-z]\.[a-z]/.test(rawName)
      ? rawName
      : rawName.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
    const problem = buildProblem(request, code, error.name || 'Error', status, error.message);
    return sendProblem(reply, problem);
  });
}
