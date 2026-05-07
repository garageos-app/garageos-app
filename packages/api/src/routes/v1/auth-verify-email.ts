import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { env } from '../../config/env.js';
import { businessError } from '../../lib/business-error.js';
import { hashToken } from '../../lib/email-verification.js';
import { markCustomerEmailVerified } from '../../lib/cognito.js';

// POST /v1/auth/verify-email — public route, the token is the auth.
//
// Hash the plaintext, look up the row, validate not consumed and not
// expired, flip consumed_at + customer.email_verified inside a single
// admin-role tx (per feedback_withcontext_empty_blocks_rls_writes —
// empty role blocks RLS WRITE). Then best-effort flip the Cognito
// attribute outside the tx (failure logs but does not roll back DB).
//
// See spec §7.3 in 2026-05-07-ses-verify-email-design.md.

const VerifyEmailBodySchema = z.object({
  token: z.string().uuid(),
});

export const authVerifyEmailRoutes: FastifyPluginAsync = async (app) => {
  app.post('/v1/auth/verify-email', async (request, reply) => {
    const parsed = VerifyEmailBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw parsed.error;
    }
    const tokenHash = hashToken(parsed.data.token);

    const result = await app.withContext({ role: 'admin' as const }, async (tx) => {
      // No FOR UPDATE in Prisma — relies on the unique index + the
      // consumed_at predicate inside the UPDATE for race safety. A
      // double-click double-fires both, but only the first UPDATE
      // sees consumed_at IS NULL.
      const record = await tx.emailVerification.findUnique({ where: { tokenHash } });
      if (!record) {
        throw businessError(
          'auth.verify_email.token_not_found',
          404,
          'Token di verifica non trovato.',
        );
      }
      if (record.consumedAt !== null) {
        throw businessError(
          'auth.verify_email.token_consumed',
          410,
          'Questo link è già stato utilizzato. Richiedi un nuovo link via "Invia di nuovo".',
        );
      }
      if (record.expiresAt < new Date()) {
        throw businessError(
          'auth.verify_email.token_expired',
          410,
          'Questo link è scaduto. Richiedi un nuovo link via "Invia di nuovo".',
        );
      }

      const customer = await tx.customer.findUnique({
        where: { id: record.customerId },
        select: { id: true, email: true, cognitoSub: true },
      });
      if (!customer) {
        // Should not happen given FK + ON DELETE CASCADE, but defensive.
        throw businessError(
          'auth.verify_email.token_not_found',
          404,
          'Token di verifica non trovato.',
        );
      }

      await tx.emailVerification.update({
        where: { id: record.id },
        data: { consumedAt: new Date() },
      });
      await tx.customer.update({
        where: { id: customer.id },
        data: { emailVerified: true },
      });

      return { customerId: customer.id, email: customer.email };
    });

    // Best-effort Cognito flip outside tx (failure logs, no rollback).
    try {
      await markCustomerEmailVerified({
        poolId: env.COGNITO_CLIENTI_POOL_ID,
        email: result.email,
      });
    } catch (err) {
      request.log.error(
        { err, customerId: result.customerId },
        'cognito email_verified flip failed (best-effort, DB row already updated)',
      );
    }

    return reply.code(200).send(result);
  });
};
