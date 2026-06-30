import type { FastifyPluginAsync } from 'fastify';

import { resolvePiiVisibility } from '../../lib/pii-filter.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

// GET /v1/disputes/open — F-OFF-501 PR3 (HomeDashboard "Contestazioni"
// card). Returns disputes open to the calling tenant grouped by lifecycle
// stage:
//   - pendingResponse: status = 'open'           (drives the red banner)
//   - inProgress    : status IN ('responded', 'escalated')
//   - excluded      : 'resolved_by_cancellation', 'closed_by_admin'
//
// RLS topology: intervention_disputes USING clause permits both
// is_admin_role(), customer scope (customer_id = current_customer_id),
// and the tenant scope (EXISTS interventions WHERE tenant_id = current).
// We enforce tenant scoping explicitly via `where: { intervention:
// { tenantId } }` to guarantee deterministic isolation regardless of
// session GUC drift. Same defensive pattern as
// interventions-disputes-list.ts + interventions-recent.ts post the
// RLS split (PR #22/#28 + feedback_rls_split_changes_endpoint_semantics).
//
// PII filter (BR-151): customerName composed only when the calling
// tenant has a CustomerTenantRelation row for the dispute's customerId.
// Otherwise fallback to the literal "Cliente" (defensive UX; not a
// numbered BR, see feedback_br_number_collision_in_doc — BR-213 is
// occupied by F-OFF-004 cross-tenant email collision).

const LIMIT_PER_GROUP = 20;
const CUSTOMER_FALLBACK = 'Cliente';

function deriveCustomerName(
  customer: {
    isBusiness: boolean;
    businessName: string | null;
    firstName: string;
    lastName: string;
  },
  visible: boolean,
): string {
  if (!visible) return CUSTOMER_FALLBACK;
  if (customer.isBusiness) {
    return customer.businessName ?? CUSTOMER_FALLBACK;
  }
  return `${customer.firstName} ${customer.lastName}`.trim() || CUSTOMER_FALLBACK;
}

const disputesOpenRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/disputes/open',
    { preHandler: [requireAuth, requireOfficinaPool, tenantContext] },
    async (request) => {
      const tenantId = request.tenantId!;
      const interventionWhere = { tenantId };

      return app.withContext({ tenantId, role: 'user' as const }, async (tx) => {
        const selectShape = {
          id: true,
          interventionId: true,
          customerId: true,
          createdAt: true,
          status: true,
          reasonCategory: true,
          intervention: { select: { vehicle: { select: { plate: true } } } },
          customer: {
            select: {
              isBusiness: true,
              businessName: true,
              firstName: true,
              lastName: true,
            },
          },
        } as const;

        const [pendingItems, pendingCount, inProgressItems, inProgressCount] = await Promise.all([
          tx.interventionDispute.findMany({
            where: {
              intervention: interventionWhere,
              status: 'open',
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: LIMIT_PER_GROUP,
            select: selectShape,
          }),
          tx.interventionDispute.count({
            where: { intervention: interventionWhere, status: 'open' },
          }),
          tx.interventionDispute.findMany({
            where: {
              intervention: interventionWhere,
              status: { in: ['responded', 'escalated'] },
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: LIMIT_PER_GROUP,
            select: selectShape,
          }),
          tx.interventionDispute.count({
            where: {
              intervention: interventionWhere,
              status: { in: ['responded', 'escalated'] },
            },
          }),
        ]);

        const allCustomerIds = [
          ...pendingItems.map((r) => r.customerId),
          ...inProgressItems.map((r) => r.customerId),
        ];
        const visibleSet = await resolvePiiVisibility({
          tx,
          tenantId,
          customerIds: allCustomerIds,
        });

        return {
          pendingResponse: {
            count: pendingCount,
            items: pendingItems.map((r) => ({
              id: r.id,
              interventionId: r.interventionId,
              vehicleTarga: r.intervention.vehicle.plate,
              customerName: deriveCustomerName(r.customer, visibleSet.has(r.customerId)),
              createdAt: r.createdAt.toISOString(),
              reasonCategory: r.reasonCategory,
            })),
          },
          inProgress: {
            count: inProgressCount,
            items: inProgressItems.map((r) => ({
              id: r.id,
              interventionId: r.interventionId,
              vehicleTarga: r.intervention.vehicle.plate,
              customerName: deriveCustomerName(r.customer, visibleSet.has(r.customerId)),
              createdAt: r.createdAt.toISOString(),
              status: r.status,
              reasonCategory: r.reasonCategory,
            })),
          },
        };
      });
    },
  );
};

export default disputesOpenRoutes;
