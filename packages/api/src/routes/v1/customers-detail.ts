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

// BR-151: PII gating — 404 when caller's tenant has no active CTR for
// the requested customer. Mirrors the customers/search tenant-scoping
// pattern but returns a single full DTO instead of a paginated list.
const paramsSchema = z.object({ id: z.uuid() });

const customerDetailRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/customers/:id',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request) => {
      const { id } = paramsSchema.parse(request.params);
      const tenantId = request.tenantId!;

      return app.withContext({ tenantId }, async (tx) => {
        const row = (await tx.customer.findFirst({
          where: {
            id,
            status: 'active',
            tenantRelations: {
              some: { tenantId, customerDeleted: false },
            },
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

export default customerDetailRoutes;
