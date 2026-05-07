import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { Prisma } from '@garageos/database';
import { env } from '../../config/env.js';
import { businessError } from '../../lib/business-error.js';
import {
  CognitoEmailAlreadyExistsError,
  CognitoInvalidPasswordError,
  createCustomerCognitoUser,
  deleteCognitoUser,
  setCustomerCognitoPassword,
} from '../../lib/cognito.js';
import { customerSelfSelect, projectCustomerSelf } from '../../lib/customer-shared.js';
import { DEFAULT_NOTIFICATION_PREFERENCES } from '../../lib/notification-preferences.js';
import {
  generateVerificationToken,
  buildVerificationUrl,
  VERIFICATION_TOKEN_TTL_MS,
} from '../../lib/email-verification.js';
import { sendVerificationEmail } from '../../lib/ses-client.js';

// POST /v1/auth/signup (F-CLI-001) — public endpoint, no auth pre-handler.
// Customer-only in v1: tenant_admin signup is rejected with 422 and will
// ship in a separate PR (see docs/superpowers/specs/2026-05-04-api-customer-signup-design.md
// §11). Email verification (cluster G SES wiring) is now wired: Phase 1
// persists the token hash in `email_verifications` and Phase 4 sends the
// email best-effort. Cognito `email_verified` starts at 'false' and flips
// to 'true' once the customer follows the verify-email link.
//
// 3-phase handler:
//   Phase 1 — DB tx: find/promote/create Customer + AuditLog + verify-email token
//   Phase 2 — Cognito: AdminCreateUser → AdminSetUserPassword
//   Phase 3 — best-effort Customer.cognito_sub update
//   Phase 4 — best-effort SES send of the verify-email link
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
  app.post(
    '/v1/auth/signup',
    {
      config: {
        rateLimit: {
          // BR-225: prevent brute-force / enumeration via repeated signups.
          // 5 attempts per 15 minutes per IP — generous for legitimate users,
          // tight enough to block scripted abuse.
          max: 5,
          timeWindow: '15 minutes',
          errorResponseBuilder: (_request, context) => {
            // @fastify/rate-limit throws the return value of this function.
            // Return an Error with statusCode + dot-separated name so the
            // shared error-handler (error-handler.ts) emits a Problem+JSON
            // response with code: 'auth.signup.rate_limited'.
            const retryAfter = Math.ceil(context.ttl / 1000);
            const err = new Error(
              `Troppi tentativi di registrazione. Riprova tra qualche minuto. Retry dopo ${retryAfter}s.`,
            ) as Error & { statusCode: number; retryAfter: number };
            err.name = 'auth.signup.rate_limited';
            err.statusCode = 429;
            err.retryAfter = retryAfter;
            return err;
          },
        },
      },
    },
    async (request, reply) => {
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

      // Cognito pool for the clienti (customer) user pool. Sourced from the
      // validated env singleton — pattern mirrors other routes that read
      // env directly (e.g. plugins/auth.ts).
      const poolId = env.COGNITO_CLIENTI_POOL_ID;

      // ─── Phase 1 — DB transaction ───────────────────────────────────────────
      // withContext signature is { tenantId?: string; customerId?: string;
      // role?: 'admin' | 'user' } — 'system' is not a supported role.
      // Signup is a cross-tenant public endpoint with no JWT → no tenantId
      // to scope to. We use role: 'admin' to bypass the customers RLS
      // _write policy (USING is_admin_role() OR EXISTS related-tenant), which
      // would otherwise deny PROMOTE and the Phase 3 cognito_sub update for
      // brand-new customers (no customer_tenant_relations row yet).
      // The privacy boundary for the customer write here is application-level:
      // the body is Zod-validated and only writes to the row identified by
      // the unique email lookup. Mirror of the admin-role usage in
      // routes/v1/interventions-dispute.ts for the same class of unauthenticated
      // cross-tenant write. See spec §8.1 in
      // docs/superpowers/specs/2026-05-04-api-customer-signup-design.md.
      const { customer, promoted, verifyToken } = await app.withContext(
        { role: 'admin' as const },
        async (tx) => {
          // BR-220 race serialization: hold an xact-scoped advisory lock keyed
          // on `signup:<email>`. Concurrent signup tx for the same email block
          // here until COMMIT/ROLLBACK; serializes both CREATE-CREATE and
          // PROMOTE-PROMOTE timings. hashtext collisions (32-bit space) only
          // cause brief contention between unrelated emails — never correctness
          // loss; customers.email unique index remains the source of truth.
          // See APPENDICE_F BR-220 + spec 2026-05-06-fix-auth-signup-br220-race.
          // Cast `void` → `text` because Prisma 7 + @prisma/adapter-pg cannot
          // deserialize a `void` column ("Unsupported native data type"). The
          // cast yields an empty string which we discard. See
          // feedback_pg_void_return_prisma_adapter (post-CI hotfix).
          await tx.$queryRawUnsafe<unknown[]>(
            `SELECT pg_advisory_xact_lock(hashtext($1))::text`,
            `signup:${body.email}`,
          );

          const existing = await tx.customer.findUnique({
            where: { email: body.email },
            select: { ...customerSelfSelect, cognitoSub: true, appInstalled: true },
          });

          // BR-224 alignment: a row is "promotable shadow" iff cognito_sub IS
          // NULL AND app_installed = false. The pre-fix predicate (cognitoSub
          // IS NULL only) misclassified an in-flight or post-rollback signup
          // (cognito_sub=NULL, app_installed=true) as shadow → BR-220 race bug.
          // NOTE: race-loss audit emission is deliberately deferred — emitting
          // inside this $transaction would be rolled back by the throw below.
          // See project_tech_debt.md for the proper out-of-tx wiring follow-up.
          if (existing && (existing.cognitoSub !== null || existing.appInstalled === true)) {
            throw businessError(
              'auth.signup.email_already_active',
              409,
              'Un account con questa email è già registrato. Effettua il login.',
            );
          }

          let row;
          let didPromote: boolean;
          if (existing) {
            // PROMOTE branch: shadow customer becomes claimed — see BR-221.
            didPromote = true;
            row = await tx.customer.update({
              where: { id: existing.id },
              data: {
                firstName: body.firstName,
                lastName: body.lastName,
                ...(body.phone ? { phone: body.phone } : {}),
                appInstalled: true,
                // BR-226: apply default notification preferences on promote,
                // not just on CREATE — shadow rows seeded by an officina carry
                // an empty {} prefs object and would never get the defaults
                // otherwise.
                notificationPreferences: DEFAULT_NOTIFICATION_PREFERENCES,
              },
              select: customerSelfSelect,
            });
          } else {
            // CREATE branch — see BR-220.
            didPromote = false;
            try {
              row = await tx.customer.create({
                data: {
                  email: body.email,
                  firstName: body.firstName,
                  lastName: body.lastName,
                  ...(body.phone ? { phone: body.phone } : {}),
                  status: 'active',
                  appInstalled: true,
                  notificationPreferences: DEFAULT_NOTIFICATION_PREFERENCES,
                },
                select: customerSelfSelect,
              });
            } catch (err) {
              if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
                // Race with concurrent signup — we cannot know whether the
                // racing request is mid-Phase-2, so the safest response is
                // 409 (client should redirect to login).
                throw businessError(
                  'auth.signup.email_already_active',
                  409,
                  'Un account con questa email è già registrato. Effettua il login.',
                );
              }
              throw err;
            }
          }

          await tx.auditLog.create({
            data: {
              tenantId: null,
              actorType: 'customer',
              actorId: row.id,
              action: 'customer_signup',
              entityType: 'customer',
              entityId: row.id,
              metadata: { promoted: didPromote, ip: request.ip },
              ipAddress: request.ip,
            },
          });

          // Generate verify-email token + persist hash. Plaintext is held in
          // a closure variable to be sent via SES post-commit. Single-use,
          // 24h TTL, hash-only storage. See spec §4.2 + §6.1.
          const { plaintext: verifyToken, hash: verifyTokenHash } = generateVerificationToken();
          await tx.emailVerification.create({
            data: {
              customerId: row.id,
              tokenHash: verifyTokenHash,
              expiresAt: new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS),
            },
          });

          return { customer: row, promoted: didPromote, verifyToken };
        },
      );

      // ─── Phase 2 — Cognito (DB tx is closed) ────────────────────────────────
      let cognitoSub: string;
      try {
        const created = await createCustomerCognitoUser({
          poolId,
          email: body.email,
          firstName: body.firstName,
          lastName: body.lastName,
          customerId: customer.id,
        });
        cognitoSub = created.cognitoSub;
      } catch (err) {
        if (err instanceof CognitoEmailAlreadyExistsError) {
          request.log.warn(
            { customerId: customer.id, email: body.email },
            'cognito user already exists for a customer DB row that looked promotable — operator reconcile',
          );
          throw businessError(
            'auth.signup.email_already_active',
            409,
            'Un account con questa email è già registrato. Effettua il login.',
          );
        }
        if (err instanceof CognitoInvalidPasswordError) {
          throw businessError(
            'auth.signup.password_policy_violation',
            422,
            'La password non rispetta i requisiti del sistema (almeno 8 caratteri, una minuscola, una cifra).',
          );
        }
        throw businessError(
          'auth.signup.cognito_unavailable',
          502,
          'Servizio di autenticazione temporaneamente non disponibile. Riprova tra qualche istante.',
        );
      }

      try {
        await setCustomerCognitoPassword({ poolId, email: body.email, password: body.password });
      } catch (err) {
        // Roll back the just-created Cognito user — we cannot leave it in
        // FORCE_CHANGE_PASSWORD state without a known credential.
        request.log.warn(
          { customerId: customer.id, email: body.email },
          'rolling back cognito user',
        );
        await deleteCognitoUser({ poolId, email: body.email }).catch((rollbackErr) => {
          request.log.error(
            { err: rollbackErr, customerId: customer.id },
            'cognito rollback failed — operator must clean up',
          );
        });
        if (err instanceof CognitoInvalidPasswordError) {
          throw businessError(
            'auth.signup.password_policy_violation',
            422,
            'La password non rispetta i requisiti del sistema.',
          );
        }
        throw businessError(
          'auth.signup.cognito_unavailable',
          502,
          'Servizio di autenticazione temporaneamente non disponibile.',
        );
      }

      // ─── Phase 3 — best-effort cognito_sub update ───────────────────────────
      // Non-fatal: if this fails the customer row lacks cognitoSub but the
      // Cognito custom:customer_id attribute is the authoritative link.
      await app
        .withContext({ role: 'admin' as const }, async (tx) =>
          tx.customer.update({
            where: { id: customer.id },
            data: { cognitoSub },
          }),
        )
        .catch((err) => {
          request.log.warn(
            { err, customerId: customer.id, cognitoSub },
            'phase 3 update of customer.cognito_sub failed — non-fatal, JWT lookup uses claim',
          );
        });

      // Best-effort verify-email SES send. Token persists in DB regardless;
      // resend route recovers if SES fails (transient error / sandbox not
      // yet exited). Sentry captures via app log.error → CloudWatch.
      const verifyUrl = buildVerificationUrl(
        process.env.VERIFY_EMAIL_BASE_URL ?? 'https://app.garageos.aifollyadvisor.com/verify-email',
        verifyToken,
      );
      try {
        await sendVerificationEmail({
          toAddress: body.email,
          customerName: body.firstName,
          verificationUrl: verifyUrl,
        });
      } catch (err) {
        request.log.error(
          { err, customerId: customer.id },
          'verify-email SES send failed (best-effort, token persisted in DB)',
        );
      }

      void promoted; // already in audit metadata; reserved for future telemetry
      return reply.code(201).send({ customer: projectCustomerSelf(customer) });
    },
  );
};
