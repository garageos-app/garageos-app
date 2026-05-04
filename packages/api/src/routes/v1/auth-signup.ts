import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { businessError } from '../../lib/business-error.js';

// POST /v1/auth/signup (F-CLI-001) — public endpoint, no auth pre-handler.
// Customer-only in v1: tenant_admin signup is rejected with 422 and will
// ship in a separate PR (see docs/superpowers/specs/2026-05-04-api-customer-signup-design.md
// §11). Email verification is deferred to the SES wiring PR (cluster G);
// signup sets email_verified=true on the Cognito user as a v1 pragma.
//
// 3-phase handler:
//   Phase 1 — DB tx: find/promote/create Customer + AuditLog
//   Phase 2 — Cognito: AdminCreateUser → AdminSetUserPassword
//   Phase 3 — best-effort Customer.cognito_sub update
//
// See APPENDICE_A §3.1, APPENDICE_F BR-220/221/224/225/226, APPENDICE_C §5.5.

const customerBodySchema = z.object({
  type: z.literal('customer'),
  email: z
    .email()
    .max(255)
    .transform((s) => s.trim().toLowerCase()),
  password: z.string().min(8).max(256),
  firstName: z
    .string()
    .min(1)
    .max(100)
    .transform((s) => s.trim()),
  lastName: z
    .string()
    .min(1)
    .max(100)
    .transform((s) => s.trim()),
  phone: z
    .string()
    .regex(/^\+?[0-9]{8,20}$/)
    .optional(),
});

const tenantAdminBodySchema = z
  .object({
    type: z.literal('tenant_admin'),
  })
  .passthrough();

const SignupBodySchema = z.discriminatedUnion('type', [customerBodySchema, tenantAdminBodySchema]);

export const authSignupRoutes: FastifyPluginAsync = async (app) => {
  app.post('/v1/auth/signup', async (request, reply) => {
    const parsed = SignupBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw parsed.error;
    }
    const body = parsed.data;

    if (body.type === 'tenant_admin') {
      throw businessError(
        'auth.signup.tenant_signup_not_supported',
        422,
        'La registrazione per profili officina non è ancora disponibile via questo endpoint.',
      );
    }

    // Phase 1-3 implementation lands in subsequent tasks.
    void body;
    void reply;
    throw businessError('auth.signup.not_implemented', 501, 'Customer signup not yet implemented.');
  });
};
