import { Prisma } from '@garageos/database';
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

// F-OFF-201 standalone customer creation. Email is globally unique, so a
// person is a single Customer row shared across tenants via CTR. Creating a
// customer whose email already exists reuses the row and ensures a CTR
// (BR-041/BR-152) — mirrors resolveCustomer (create_new) in vehicles.ts,
// which is intentionally left untouched.
const bodySchema = z
  .object({
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    email: z.string().trim().email().max(255),
    phone: z.string().max(30).optional(),
    taxCode: z.string().max(20).optional(),
    addressLine: z.string().max(255).optional(),
    city: z.string().max(100).optional(),
    province: z.string().max(2).optional(),
    postalCode: z.string().max(10).optional(),
    isBusiness: z.boolean().default(false),
    businessName: z.string().max(200).optional(),
    vatNumber: z.string().max(20).optional(),
  })
  .strict();

const customerCreateRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/v1/customers',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request, reply) => {
      // safeParse to discriminate unknown keys (422 domain code) from
      // generic validation errors (400 VALIDATION_ERROR via global handler).
      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) {
        const hasUnknown = parsed.error.issues.some((i) => i.code === 'unrecognized_keys');
        if (hasUnknown) {
          throw businessError('customer.create.unknown_field', 422, 'Campo non riconosciuto.');
        }
        throw parsed.error;
      }
      const body = parsed.data;
      if (body.isBusiness && !body.businessName?.trim()) {
        throw businessError(
          'customer.create.business_name_required',
          422,
          'La ragione sociale è obbligatoria per un cliente aziendale.',
        );
      }

      const tenantId = request.tenantId!;

      return app.withContext({ tenantId }, async (tx) => {
        // Dedupe by the globally-unique email (BR-041).
        const existing = await tx.customer.findUnique({
          where: { email: body.email },
          select: { id: true },
        });

        let customerId: string;
        let created: boolean;
        if (existing) {
          customerId = existing.id;
          created = false;
        } else {
          try {
            const row = await tx.customer.create({
              data: {
                firstName: body.firstName,
                lastName: body.lastName,
                email: body.email,
                isBusiness: body.isBusiness,
                ...(body.phone ? { phone: body.phone } : {}),
                ...(body.taxCode ? { taxCode: body.taxCode } : {}),
                ...(body.addressLine ? { addressLine: body.addressLine } : {}),
                ...(body.city ? { city: body.city } : {}),
                ...(body.province ? { province: body.province } : {}),
                ...(body.postalCode ? { postalCode: body.postalCode } : {}),
                ...(body.businessName ? { businessName: body.businessName } : {}),
                ...(body.vatNumber ? { vatNumber: body.vatNumber } : {}),
              },
              select: { id: true },
            });
            customerId = row.id;
            created = true;
          } catch (err) {
            // P2002 race: a concurrent insert won between findUnique and
            // create. Re-fetch and treat as a reuse (BR-041 dedupe-hit).
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
              const raced = await tx.customer.findUniqueOrThrow({
                where: { email: body.email },
                select: { id: true },
              });
              customerId = raced.id;
              created = false;
            } else {
              throw err;
            }
          }
        }

        // BR-152: ensure the calling tenant is related to the customer.
        // Atomic upsert avoids the find-then-create race.
        await tx.customerTenantRelation.upsert({
          where: { tenantId_customerId: { tenantId, customerId } },
          update: {},
          create: { tenantId, customerId, interventionCount: 0 },
          select: { id: true },
        });

        const row = (await tx.customer.findFirst({
          where: {
            id: customerId,
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
          // Unreachable: we just ensured the customer + CTR exist.
          throw businessError('customer.not_found', 404, 'Cliente non trovato dopo la creazione.');
        }

        reply.code(201);
        return { ...projectCustomerDetail(row), created };
      });
    },
  );
};

export default customerCreateRoutes;
