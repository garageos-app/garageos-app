import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { businessError } from '../../lib/business-error.js';
import { customerSelfSelect, projectCustomerSelf } from '../../lib/customer-shared.js';
import { clientiContext } from '../../middleware/clienti-context.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireClientiPool } from '../../middleware/require-clienti-pool.js';

// GET /v1/me + PATCH /v1/me/profile — F-CLI-004 (customer self-profile).
//
// GET reads the caller's own row under role:'user' (customers_read RLS is
// USING(true)); the app-layer where:{id:customerId} scopes to self.
//
// PATCH runs under role:'admin' because the customers UPDATE policy
// (customers_write_by_related_tenant = is_admin_role() OR EXISTS related-tenant)
// has no `id = current_customer_id()` clause, so a self-update in role:'user'
// is denied by RLS. This mirrors the signup customer-self-write precedent
// (auth-signup.ts); the privacy boundary is the explicit where:{id:customerId}
// plus the Zod-validated, strict, editable-only body. email/status/createdAt
// are not editable. See spec 2026-06-04-F-CLI-004-pr1-customer-self-profile-api-design.

const patchBodySchema = z
  .object({
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    phone: z
      .string()
      .regex(/^\+?[0-9]{8,20}$/, 'Telefono non valido')
      .nullable(),
  })
  .partial()
  .strict();

const meProfileRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/me',
    { preHandler: [requireAuth, requireClientiPool, clientiContext] },
    async (request) => {
      const customerId = request.customerId!;
      return app.withContext({ customerId, role: 'user' }, async (tx) => {
        const row = await tx.customer.findUniqueOrThrow({
          where: { id: customerId },
          select: customerSelfSelect,
        });
        return projectCustomerSelf(row);
      });
    },
  );

  app.patch(
    '/v1/me/profile',
    { preHandler: [requireAuth, requireClientiPool, clientiContext] },
    async (request) => {
      const parsed = patchBodySchema.safeParse(request.body);
      if (!parsed.success) {
        const hasUnknown = parsed.error.issues.some((i) => i.code === 'unrecognized_keys');
        if (hasUnknown) {
          throw businessError('me.profile.update.unknown_field', 422, 'Campo non modificabile.');
        }
        throw parsed.error;
      }
      const body = parsed.data;
      if (Object.keys(body).length === 0) {
        throw businessError(
          'me.profile.update.empty_body',
          422,
          'Specifica almeno un campo da aggiornare.',
        );
      }

      const customerId = request.customerId!;
      const patch: Record<string, string | null> = {};
      if ('firstName' in body) patch['firstName'] = body.firstName!;
      if ('lastName' in body) patch['lastName'] = body.lastName!;
      if ('phone' in body) patch['phone'] = body.phone ?? null;

      // role:'admin' — see header comment (customers UPDATE RLS has no self clause).
      return app.withContext({ role: 'admin' }, async (tx) => {
        const row = await tx.customer.update({
          where: { id: customerId },
          data: patch,
          select: customerSelfSelect,
        });
        return projectCustomerSelf(row);
      });
    },
  );
};

export default meProfileRoutes;
