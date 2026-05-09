import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { businessError } from '../../lib/business-error.js';
import {
  customerDetailSelect,
  projectCustomerDetail,
  type CustomerDetailRow,
} from '../../lib/customer-detail-shared.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

const paramsSchema = z.object({ id: z.uuid() });

// .strict() so unknown keys (email, cognitoSub, status, etc.) trigger
// a Zod ZodIssueCode.unrecognized_keys → mapped to
// customer.update.unknown_field 422. Explicit refusal makes the
// email-immutability invariant testable.
const bodySchema = z
  .object({
    firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100),
    phone: z.string().max(30).nullable(),
    taxCode: z.string().max(20).nullable(),
    isBusiness: z.boolean(),
    businessName: z.string().max(200).nullable(),
    vatNumber: z.string().max(20).nullable(),
    addressLine: z.string().max(255).nullable(),
    city: z.string().max(100).nullable(),
    province: z.string().max(2).nullable(),
    postalCode: z.string().max(10).nullable(),
    tenantNotes: z.string().max(5000).nullable(),
  })
  .partial()
  .strict();

const ANAGRAFICA_KEYS = [
  'firstName',
  'lastName',
  'phone',
  'taxCode',
  'isBusiness',
  'businessName',
  'vatNumber',
  'addressLine',
  'city',
  'province',
  'postalCode',
] as const;

const customerUpdateRoutes: FastifyPluginAsync = async (app) => {
  app.patch(
    '/v1/customers/:id',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request) => {
      const { id } = paramsSchema.parse(request.params);
      const tenantId = request.tenantId!;

      // Catch the parse to discriminate unknown_field (422 domain code)
      // from generic validation errors (400 VALIDATION_ERROR via global
      // handler).
      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) {
        const hasUnknown = parsed.error.issues.some((i) => i.code === 'unrecognized_keys');
        if (hasUnknown) {
          throw businessError('customer.update.unknown_field', 422, 'Campo non modificabile.');
        }
        // Re-raise so the global handler emits 400 VALIDATION_ERROR with
        // the canonical errors[] breakdown.
        throw parsed.error;
      }
      const body = parsed.data;
      if (Object.keys(body).length === 0) {
        throw businessError(
          'customer.update.empty_body',
          422,
          'Specifica almeno un campo da aggiornare.',
        );
      }

      return app.withContext({ tenantId }, async (tx) => {
        // CTR existence check — symmetry with GET 404 + BR-151.
        const ctr = await tx.customerTenantRelation.findFirst({
          where: { tenantId, customerId: id, customerDeleted: false },
          select: { id: true },
        });
        if (!ctr) {
          throw businessError(
            'customer.not_found',
            404,
            'Cliente non trovato o non accessibile da questa officina.',
          );
        }

        await tx.$transaction(async (t) => {
          const anagraficaPatch: Record<string, unknown> = {};
          for (const key of ANAGRAFICA_KEYS) {
            if (key in body) anagraficaPatch[key] = body[key];
          }
          if (Object.keys(anagraficaPatch).length > 0) {
            await t.customer.update({
              where: { id },
              data: anagraficaPatch,
            });
          }
          if ('tenantNotes' in body) {
            // Prisma 7 compound unique key uses camelCase field names,
            // not the DB constraint map name (uq_customer_tenant).
            await t.customerTenantRelation.update({
              where: { tenantId_customerId: { tenantId, customerId: id } },
              // exactOptionalPropertyTypes: body.tenantNotes is
              // string | null | undefined; cast to string | null.
              data: { tenantNotes: body.tenantNotes ?? null },
            });
          }
        });

        const row = (await tx.customer.findFirst({
          where: {
            id,
            status: 'active',
            tenantRelations: { some: { tenantId, customerDeleted: false } },
          },
          select: {
            ...customerDetailSelect,
            tenantRelations: {
              ...customerDetailSelect.tenantRelations,
              where: { tenantId, customerDeleted: false },
            },
          },
        })) as CustomerDetailRow | null;

        if (!row) {
          // Defensive — should be unreachable after CTR check above.
          throw businessError(
            'customer.not_found',
            404,
            'Cliente non trovato o non accessibile da questa officina.',
          );
        }
        return projectCustomerDetail(row);
      });
    },
  );
};

export default customerUpdateRoutes;
