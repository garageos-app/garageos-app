import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import {
  generateVerificationToken,
  buildVerificationUrl,
  VERIFICATION_TOKEN_TTL_MS,
} from '../../lib/email-verification.js';
import { sendVerificationEmail } from '../../lib/ses-client.js';

// POST /v1/auth/resend-verification — public, rate-limited 5/min/IP.
// Anti-enumeration: returns 200 { sent: true } regardless of whether the
// email exists. No timing protection — that would require constant-time
// branching that's harder to maintain and not in scope for v1.
//
// See spec §7.4 in 2026-05-07-ses-verify-email-design.md.

const ResendBodySchema = z.object({
  email: z
    .email()
    .max(255)
    .transform((s) => s.trim().toLowerCase()),
});

export const authResendVerificationRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/v1/auth/resend-verification',
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
          errorResponseBuilder: (_request, context) => {
            const retryAfter = Math.ceil(context.ttl / 1000);
            const err = new Error(
              `Troppi tentativi. Riprova tra qualche minuto. Retry dopo ${retryAfter}s.`,
            ) as Error & { statusCode: number; retryAfter: number };
            err.name = 'auth.resend_verification.rate_limited';
            err.statusCode = 429;
            err.retryAfter = retryAfter;
            return err;
          },
        },
      },
    },
    async (request, reply) => {
      const parsed = ResendBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw parsed.error;
      }

      let plaintextToken: string | null = null;
      let recipientName: string | null = null;
      await app.withContext({ role: 'admin' as const }, async (tx) => {
        const customer = await tx.customer.findFirst({
          where: { email: parsed.data.email },
          select: { id: true, email: true, firstName: true },
        });
        if (!customer) {
          // Anti-enum audit log (no row lookup signal to caller).
          request.log.info(
            { email: parsed.data.email },
            'resend-verification requested for unknown email (no-op)',
          );
          return;
        }
        await tx.emailVerification.updateMany({
          where: { customerId: customer.id, consumedAt: null },
          data: { consumedAt: new Date() },
        });
        const { plaintext, hash } = generateVerificationToken();
        await tx.emailVerification.create({
          data: {
            customerId: customer.id,
            tokenHash: hash,
            expiresAt: new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS),
          },
        });
        plaintextToken = plaintext;
        recipientName = customer.firstName;
      });

      if (plaintextToken && recipientName) {
        const verifyUrl = buildVerificationUrl(
          process.env.VERIFY_EMAIL_BASE_URL ??
            'https://app.garageos.aifollyadvisor.com/verify-email',
          plaintextToken,
        );
        try {
          await sendVerificationEmail({
            toAddress: parsed.data.email,
            customerName: recipientName,
            verificationUrl: verifyUrl,
          });
        } catch (err) {
          request.log.error(
            { err, email: parsed.data.email },
            'resend-verification SES send failed (best-effort, token persisted in DB)',
          );
        }
      }

      return reply.code(200).send({ sent: true });
    },
  );
};
