import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { businessError } from '../../lib/business-error.js';
import {
  EDITABLE_EMAIL_KEYS,
  projectNotificationPreferences,
  type EditableEmailKey,
} from '../../lib/notification-preferences.js';
import { clientiContext } from '../../middleware/clienti-context.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireClientiPool } from '../../middleware/require-clienti-pool.js';

// GET + PATCH /v1/me/notification-preferences — F-CLI-005 (customer
// notification preferences). Mirrors me-profile.ts: GET under role:'user'
// (customers_read RLS is USING(true), app-layer where:{id} scopes to self);
// PATCH under role:'admin' (customers UPDATE policy has no self clause).
//
// Editable surface = 4 email keys (see EDITABLE_EMAIL_KEYS). PATCH deep-merges
// onto the stored JSON, preserving non-editable keys.
// See BR-226 (default shape) + BR-260 (transfer_invitation always-sent, not editable).

const editableEmailSchema = z
  .object(
    Object.fromEntries(EDITABLE_EMAIL_KEYS.map((k) => [k, z.boolean()])) as Record<
      EditableEmailKey,
      z.ZodBoolean
    >,
  )
  .partial()
  .strict();

const patchBodySchema = z.object({ email: editableEmailSchema }).partial().strict();

const meNotificationPreferencesRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/me/notification-preferences',
    { preHandler: [requireAuth, requireClientiPool, clientiContext] },
    async (request) => {
      const customerId = request.customerId!;
      return app.withContext({ customerId, role: 'user' }, async (tx) => {
        const row = await tx.customer.findUniqueOrThrow({
          where: { id: customerId },
          select: { notificationPreferences: true },
        });
        return projectNotificationPreferences(row.notificationPreferences);
      });
    },
  );

  app.patch(
    '/v1/me/notification-preferences',
    { preHandler: [requireAuth, requireClientiPool, clientiContext] },
    async (request) => {
      const parsed = patchBodySchema.safeParse(request.body);
      if (!parsed.success) {
        const hasUnknown = parsed.error.issues.some((i) => i.code === 'unrecognized_keys');
        if (hasUnknown) {
          throw businessError(
            'me.notification-preferences.update.unknown_field',
            422,
            'Campo non modificabile.',
          );
        }
        throw parsed.error;
      }

      const email = parsed.data.email ?? {};
      if (Object.keys(email).length === 0) {
        throw businessError(
          'me.notification-preferences.update.empty_body',
          422,
          'Specifica almeno una preferenza da aggiornare.',
        );
      }

      const customerId = request.customerId!;
      // role:'admin' — see header comment (customers UPDATE RLS has no self clause).
      return app.withContext({ role: 'admin' }, async (tx) => {
        const current = await tx.customer.findUniqueOrThrow({
          where: { id: customerId },
          select: { notificationPreferences: true },
        });
        const stored =
          current.notificationPreferences &&
          typeof current.notificationPreferences === 'object' &&
          !Array.isArray(current.notificationPreferences)
            ? (current.notificationPreferences as Record<string, unknown>)
            : {};
        const storedEmail =
          stored.email && typeof stored.email === 'object' && !Array.isArray(stored.email)
            ? (stored.email as Record<string, unknown>)
            : {};

        const mergedEmail = { ...storedEmail, ...email };
        const merged = { ...stored, email: mergedEmail };

        const row = await tx.customer.update({
          where: { id: customerId },
          data: { notificationPreferences: merged },
          select: { notificationPreferences: true },
        });
        return projectNotificationPreferences(row.notificationPreferences);
      });
    },
  );
};

export default meNotificationPreferencesRoutes;
