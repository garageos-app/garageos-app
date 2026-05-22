import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

// E2 customer autocomplete (Persona Giuseppe demo). Tenant-scoped via
// the customer_tenant_relations JOIN — see
// docs/superpowers/specs/2026-05-09-api-customers-search-endpoint-design.md
// §2.3 for the BR-151 rationale (customers_read RLS is permissive,
// PII gating happens in WHERE here).
//
// q matches firstName / lastName / businessName only. email / taxCode /
// vatNumber are intentionally NOT matchable via q to keep PII exposure
// from the search surface low; email is still returned in the DTO because
// the calling tenant is by construction related to every returned customer.

const searchQuerySchema = z.object({
  q: z.string().trim().min(2).max(60),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
});

const customerSearchSelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  isBusiness: true,
  businessName: true,
  vatNumber: true,
  status: true, // always 'active' — WHERE above filters anything else out
} as const;

const customerRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/customers/search',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request) => {
      const { q, limit, cursor } = searchQuerySchema.parse(request.query);
      const tenantId = request.tenantId!;

      // Split q into whitespace-separated tokens so a multi-word query
      // like "Mario Rossi" matches a customer whose first and last name
      // are stored in separate columns. Each token must match at least
      // one searchable column (AND across tokens, OR across columns).
      // q is .trim()'d by the schema, so tokens is never empty.
      const tokens = q.split(/\s+/).filter(Boolean);

      return app.withContext({ tenantId }, async (tx) => {
        const cursorId = decodeCursor(cursor);
        const rows = await tx.customer.findMany({
          where: {
            status: 'active',
            tenantRelations: { some: { tenantId, customerDeleted: false } },
            AND: tokens.map((token) => ({
              OR: [
                { firstName: { contains: token, mode: 'insensitive' as const } },
                { lastName: { contains: token, mode: 'insensitive' as const } },
                { businessName: { contains: token, mode: 'insensitive' as const } },
              ],
            })),
          },
          select: customerSearchSelect,
          orderBy: { id: 'asc' },
          take: limit + 1,
          ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
        });

        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        const lastRow = page.at(-1);

        return {
          data: page,
          meta: {
            has_more: hasMore,
            ...(hasMore && lastRow ? { cursor: encodeCursor(lastRow.id) } : {}),
          },
        };
      });
    },
  );
};

export default customerRoutes;
