import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { businessError } from '../../lib/business-error.js';
import { EXPO_PUSH_TOKEN_RE } from '../../lib/push-token.js';
import { clientiContext } from '../../middleware/clienti-context.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireClientiPool } from '../../middleware/require-clienti-pool.js';

// POST + DELETE /v1/me/push-tokens — F-CLI-302 PR1 (Expo push token
// registration). The push_tokens table + RLS policy already exist (init
// migration); this is the read/write surface.
//
// POST runs under role:'admin' (not 'user'): expo_push_token is globally
// unique, so on an account switch on the same device we must reassign a row
// owned by another customer — impossible under role:'user' (RLS hides it →
// P2002 dead-end on insert). The privacy boundary is that customer_id is
// always pinned to request.customerId. Mirrors me-profile's self-write-under-
// admin precedent. DELETE stays role:'user' (RLS scopes to the caller; a
// foreign id is invisible → findFirst null → 404). See BR-254.

const registerBodySchema = z
  .object({
    expoPushToken: z.string().regex(EXPO_PUSH_TOKEN_RE),
    platform: z.enum(['ios', 'android']),
    deviceName: z.string().trim().min(1).max(100).optional(),
    appVersion: z.string().trim().min(1).max(20).optional(),
  })
  .strict();

const idParamSchema = z.object({ id: z.string().uuid() });

const mePushTokensRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/v1/me/push-tokens',
    { preHandler: [requireAuth, requireClientiPool, clientiContext] },
    async (request, reply) => {
      const parsed = registerBodySchema.safeParse(request.body);
      if (!parsed.success) {
        const issues = parsed.error.issues;
        if (issues.some((i) => i.code === 'unrecognized_keys')) {
          throw businessError(
            'me.push-token.register.unknown_field',
            422,
            'Campo non riconosciuto.',
          );
        }
        // Zod v4 reports a failed .regex() as `invalid_format`. A missing
        // field is `invalid_type` → falls through to 400.
        if (issues.some((i) => i.path[0] === 'expoPushToken' && i.code === 'invalid_format')) {
          throw businessError(
            'me.push-token.register.invalid_token',
            422,
            'Token push non valido.',
          );
        }
        throw parsed.error; // -> 400 (missing field / bad platform)
      }

      const { expoPushToken, platform, deviceName, appVersion } = parsed.data;
      const customerId = request.customerId!;

      const id = await app.withContext({ role: 'admin' }, async (tx) => {
        const data = {
          customerId,
          expoPushToken,
          platform,
          deviceName: deviceName ?? null,
          appVersion: appVersion ?? null,
          active: true,
          lastUsedAt: new Date(),
        };

        // Branch 1: token already known (any owner) -> refresh + reassign.
        const byToken = await tx.pushToken.findUnique({
          where: { expoPushToken },
          select: { id: true },
        });
        let rowId: string;
        if (byToken) {
          await tx.pushToken.update({ where: { id: byToken.id }, data });
          rowId = byToken.id;
        } else {
          // Branch 2: same device (by name) rotated its token.
          const byDevice = deviceName
            ? await tx.pushToken.findFirst({
                where: { customerId, deviceName, active: true },
                select: { id: true },
              })
            : null;
          if (byDevice) {
            await tx.pushToken.update({ where: { id: byDevice.id }, data });
            rowId = byDevice.id;
          } else {
            // Branch 3: new device.
            const created = await tx.pushToken.create({ data, select: { id: true } });
            rowId = created.id;
          }
        }

        // BR-224: an active device now exists for this customer.
        await tx.customer.update({ where: { id: customerId }, data: { appInstalled: true } });
        return rowId;
      });

      return reply.code(201).send({ id });
    },
  );

  app.delete(
    '/v1/me/push-tokens/:id',
    { preHandler: [requireAuth, requireClientiPool, clientiContext] },
    async (request, reply) => {
      const params = idParamSchema.safeParse(request.params);
      if (!params.success) throw params.error; // -> 400

      const customerId = request.customerId!;
      await app.withContext({ customerId, role: 'user' }, async (tx) => {
        const row = await tx.pushToken.findFirst({
          where: { id: params.data.id, customerId },
          select: { id: true },
        });
        if (!row) {
          throw businessError('me.push-token.not_found', 404, 'Token push non trovato.');
        }
        await tx.pushToken.delete({ where: { id: row.id } });
      });

      return reply.code(204).send();
    },
  );
};

export default mePushTokensRoutes;
