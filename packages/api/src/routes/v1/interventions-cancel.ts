import { CancelInterventionSchema } from '@garageos/database';
import type { FastifyPluginAsync } from 'fastify';

import { recordVehicleAccess } from '../../lib/access-log.js';
import { businessError } from '../../lib/business-error.js';
import { dispatchNotification } from '../../lib/notifications/dispatcher.js';
import { resolveCurrentOwner } from '../../lib/notifications/recipient-resolver.js';
import type { CustomerForNotification } from '../../lib/notifications/types.js';
import { idParamSchema } from '../../lib/vehicle-shared.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

// POST /v1/interventions/:id/cancel — F-OFF-307. Logical cancellation
// of an officina intervention. BR-066 (super_admin only, reason >= 20
// chars, irreversible). BR-130 (cancellation flips all active disputes
// on this intervention to `resolved_by_cancellation`). BR-154 (audit
// log entry with action='cancel'). RLS interventions_update enforces
// tenant ownership; cross-tenant write falls out as P2025 → 404 via
// the shared error handler (RLS-as-404).
//
// Single TX on officina pool, no role:'admin' escape hatch. The
// intervention_disputes_access policy (single USING(...) covering all
// commands) admits officina-pool UPDATE when the parent intervention
// belongs to the current tenant — checked transitively via the
// `intervention.tenantId = current_tenant_id()` clause.

const interventionCancelRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/v1/interventions/:id/cancel',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const body = CancelInterventionSchema.parse(request.body);
      const tenantId = request.tenantId!;
      const cognitoSub = request.userId!;

      const result = await app.withContext({ tenantId }, async (tx) => {
        // (cognitoSub, tenantId) lookup post-0004 — see users.ts header.
        const user = await tx.user.findFirstOrThrow({
          where: { cognitoSub, tenantId },
          select: { id: true, role: true },
        });

        // Cross-tenant masked by interventions_update RLS (USING +
        // WITH CHECK both require tenant_id = current_tenant_id()),
        // so P2025 → 404 covers both unknown id and other-tenant id.
        const existing = await tx.intervention.findUniqueOrThrow({
          where: { id },
          select: { tenantId: true, status: true, vehicleId: true },
        });

        // Guard order: 404 → permission → reason → already_cancelled.
        // Cross-tenant stays opaque (404 first); a mechanic with bad
        // input still gets a clean 403 before any field-level check;
        // syntactic input issues precede stateful conflicts.
        if (user.role !== 'super_admin') {
          throw businessError(
            'intervention.cancellation.permission_denied',
            403,
            'Solo il super_admin del tenant può annullare un intervento.',
          );
        }

        if (body.reason.length < 20) {
          throw businessError(
            'intervention.cancellation.reason_too_short',
            400,
            'La motivazione di annullamento deve essere di almeno 20 caratteri.',
          );
        }

        if (existing.status === 'cancelled') {
          throw businessError(
            'intervention.cancellation.already_cancelled',
            409,
            'Intervento già annullato.',
          );
        }

        const now = new Date();

        await tx.intervention.update({
          where: { id },
          data: {
            status: 'cancelled',
            cancelledReason: body.reason,
            cancelledByUserId: user.id,
            cancelledAt: now,
          },
        });

        // BR-130: cancellation of an intervention auto-resolves all
        // active disputes on it. updateMany returns a count only, so
        // we re-fetch the rows that just flipped to populate the
        // response. Scoping the SELECT by `resolvedAt = now` keeps
        // pre-existing resolved_by_cancellation rows out of the result.
        await tx.interventionDispute.updateMany({
          where: {
            interventionId: id,
            status: { in: ['open', 'responded'] },
          },
          data: {
            status: 'resolved_by_cancellation',
            resolvedAt: now,
          },
        });
        const resolvedDisputes = await tx.interventionDispute.findMany({
          where: {
            interventionId: id,
            status: 'resolved_by_cancellation',
            resolvedAt: now,
          },
          select: { id: true, status: true, resolvedAt: true },
        });

        await recordVehicleAccess({
          tx,
          vehicleId: existing.vehicleId,
          tenantId,
          userId: user.id,
          action: 'cancel',
          ipAddress: request.ip,
          log: request.log,
        });

        // H1 / BR-066: resolve recipient and tenant for post-commit
        // notification. Gate the tenant fetch behind a non-null recipient
        // — if there is no active owner (or owner is deleted/anon), we
        // skip the dispatch entirely and don't pay for an extra round-trip.
        const recipient: CustomerForNotification | null = await resolveCurrentOwner(
          tx,
          existing.vehicleId,
        );
        let tenantRow: { id: string; businessName: string } | null = null;
        if (recipient) {
          tenantRow = await tx.tenant.findUniqueOrThrow({
            where: { id: tenantId },
            select: { id: true, businessName: true },
          });
        }

        const reloaded = await tx.intervention.findUniqueOrThrow({
          where: { id },
          select: {
            id: true,
            tenantId: true,
            userId: true,
            vehicleId: true,
            interventionTypeId: true,
            interventionDate: true,
            odometerKm: true,
            description: true,
            partsReplaced: true,
            internalNotes: true,
            status: true,
            cancelledReason: true,
            cancelledByUserId: true,
            cancelledAt: true,
            kmAnomaly: true,
            firstSeenByCustomerAt: true,
            wikiLockedAt: true,
            createdAt: true,
            updatedAt: true,
            interventionType: {
              select: { id: true, code: true, nameIt: true },
            },
          },
        });

        return { intervention: reloaded, resolvedDisputes, recipient, tenantRow };
      });

      // BR-066 dispatch runs AFTER the transaction commits. It is
      // best-effort: dispatchNotification never throws (see contract in
      // dispatcher.ts), so a SES failure here cannot roll back the
      // cancellation or the dispute resolution. The guard skips dispatch
      // when there is no resolvable recipient (no active owner / deleted
      // / anonymized customer) — tenantRow is gated by recipient too.
      if (result.recipient && result.tenantRow) {
        await dispatchNotification({
          event: {
            type: 'intervention.cancelled',
            intervention: {
              id: result.intervention.id,
              vehicleId: result.intervention.vehicleId,
              description: result.intervention.description,
              cancelledReason: result.intervention.cancelledReason,
            },
            tenant: result.tenantRow,
          },
          recipient: result.recipient,
          logger: request.log,
          app,
        });
      }

      return { intervention: result.intervention, resolvedDisputes: result.resolvedDisputes };
    },
  );
};

export default interventionCancelRoutes;
