import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
import {
  customerListSelect,
  projectCustomerListRow,
  type CustomerListRow,
} from '../../lib/customer-list-shared.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

// F-OFF-202 customer list. Tenant-scoped via the customer_tenant_relations
// JOIN (BR-151). Distinct from /v1/customers/search (autocomplete, q
// required, id-ordered): the list has optional q and alphabetical order.
// Least-PII DTO: only the fields shown in the list (no email/taxCode/
// vatNumber) — the detail endpoint already exposes those to the same
// related tenant.
const listQuerySchema = z.object({
  q: z.string().trim().min(2).max(60).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
});

const customerListRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/customers',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request) => {
      const { q, limit, cursor } = listQuerySchema.parse(request.query);
      const tenantId = request.tenantId!;

      // Same token split as /customers/search: AND across whitespace
      // tokens, OR across the 3 searchable columns. q is .trim()'d by the
      // schema, so tokens is never empty when q is present.
      const tokens = q ? q.split(/\s+/).filter(Boolean) : [];

      return app.withContext({ tenantId }, async (tx) => {
        const cursorId = decodeCursor(cursor);
        const rows = (await tx.customer.findMany({
          where: {
            status: 'active',
            tenantRelations: { some: { tenantId, customerDeleted: false } },
            ...(tokens.length
              ? {
                  AND: tokens.map((token) => ({
                    OR: [
                      { firstName: { contains: token, mode: 'insensitive' as const } },
                      { lastName: { contains: token, mode: 'insensitive' as const } },
                      { businessName: { contains: token, mode: 'insensitive' as const } },
                    ],
                  })),
                }
              : {}),
          },
          select: {
            ...customerListSelect,
            tenantRelations: {
              ...customerListSelect.tenantRelations,
              where: { tenantId, customerDeleted: false },
            },
          },
          orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
          take: limit + 1,
          ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
        })) as CustomerListRow[];

        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        const lastRow = page.at(-1);

        return {
          data: page.map(projectCustomerListRow),
          meta: {
            has_more: hasMore,
            ...(hasMore && lastRow ? { cursor: encodeCursor(lastRow.id) } : {}),
          },
        };
      });
    },
  );
};

export default customerListRoutes;
