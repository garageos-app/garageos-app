import { RespondToDisputeSchema } from '@garageos/database';
import type { FastifyPluginAsync } from 'fastify';

import { recordVehicleAccess } from '../../lib/access-log.js';
import { businessError } from '../../lib/business-error.js';
import { idParamSchema } from '../../lib/vehicle-shared.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

// POST /v1/interventions/:id/dispute-response — F-OFF-602. Officina
// risponde a una o più dispute `open` sull'intervento. BR-128 (storico
// immutabile: no edit/delete della response), BR-129 (tenant_response
// 20..2000), BR-127 (intervention.status flip da `disputed` ad
// `active` se non restano dispute `open` post-update).
//
// Targeting: `disputeId` opzionale → se presente, una sola dispute;
// se omesso, fanout su tutte le `open` di questa intervention. La
// risposta `responded` NON conta come "blocco PATCH" (BR-122 vale
// solo per uniqueness customer-side).
//
// RLS: il pattern è identico a interventions-cancel.ts. La policy
// intervention_disputes_access (USING covers all commands) admit
// l'UPDATE quando il parent intervention appartiene al tenant
// corrente. Cross-tenant intervention → P2025 → 404 (RLS-as-404).
//
// Permission: allow-list `[super_admin, mechanic]` esplicita per
// proteggere da future estensioni dell'enum UserRole (es. `read_only`).

const ALLOWED_ROLES = ['super_admin', 'mechanic'] as const;
type AllowedRole = (typeof ALLOWED_ROLES)[number];

function isAllowedRole(role: string): role is AllowedRole {
  return (ALLOWED_ROLES as readonly string[]).includes(role);
}

const interventionDisputeResponseRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/v1/interventions/:id/dispute-response',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const body = RespondToDisputeSchema.parse(request.body);
      const tenantId = request.tenantId!;
      const cognitoSub = request.userId!;

      return app.withContext({ tenantId }, async (tx) => {
        const user = await tx.user.findFirstOrThrow({
          where: { cognitoSub, tenantId },
          select: { id: true, role: true, locationId: true },
        });

        if (!isAllowedRole(user.role)) {
          throw businessError(
            'intervention.dispute.response.permission_denied',
            403,
            'Ruolo non autorizzato a rispondere a una contestazione.',
          );
        }

        if (body.tenantResponse.length < 20) {
          throw businessError(
            'intervention.dispute.response.description_too_short',
            400,
            'La risposta deve essere di almeno 20 caratteri.',
          );
        }

        if (body.attachmentIds && body.attachmentIds.length > 0) {
          throw businessError(
            'intervention.dispute.attachments_not_supported',
            422,
            'Allegati non ancora supportati per le risposte officina in v1.0.',
          );
        }

        const intervention = await tx.intervention.findUniqueOrThrow({
          where: { id },
          select: { tenantId: true, status: true, vehicleId: true },
        });

        // Resolve target disputes
        let targetIds: string[];
        if (body.disputeId) {
          const target = await tx.interventionDispute.findUnique({
            where: { id: body.disputeId },
            select: { id: true, interventionId: true, status: true },
          });
          if (!target || target.interventionId !== id) {
            throw businessError('not_found', 404, 'Contestazione non trovata.');
          }
          if (target.status !== 'open') {
            throw businessError(
              'intervention.dispute.response.no_active_dispute',
              409,
              'La contestazione indicata non è in stato "open".',
            );
          }
          targetIds = [target.id];
        } else {
          const openTargets = await tx.interventionDispute.findMany({
            where: { interventionId: id, status: 'open' },
            select: { id: true },
          });
          if (openTargets.length === 0) {
            throw businessError(
              'intervention.dispute.response.no_active_dispute',
              409,
              'Nessuna contestazione aperta su questo intervento.',
            );
          }
          targetIds = openTargets.map((t) => t.id);
        }

        const now = new Date();

        await tx.interventionDispute.updateMany({
          where: { id: { in: targetIds } },
          data: {
            status: 'responded',
            tenantResponse: body.tenantResponse,
            tenantResponseAt: now,
            tenantResponseUserId: user.id,
          },
        });

        const respondedDisputes = await tx.interventionDispute.findMany({
          where: { id: { in: targetIds } },
          select: {
            id: true,
            interventionId: true,
            customerId: true,
            reasonCategory: true,
            customerDescription: true,
            tenantResponse: true,
            tenantResponseAt: true,
            tenantResponseUserId: true,
            status: true,
            resolvedAt: true,
            createdAt: true,
          },
        });

        // BR-127 status flip: count residual `open` disputes on this
        // intervention. `responded` does NOT count — see header doc.
        const remainingOpen = await tx.interventionDispute.count({
          where: { interventionId: id, status: 'open' },
        });

        let interventionStatus = intervention.status;
        if (remainingOpen === 0 && intervention.status === 'disputed') {
          await tx.intervention.update({
            where: { id },
            data: { status: 'active' },
          });
          interventionStatus = 'active';
        }

        // TODO(BR-129 follow-up): notify customer via push + email when
        // push tokens infra (BR-251) and SES path ship. Tracked in
        // project_tech_debt.md alongside BR-064/066 deferrals.

        await recordVehicleAccess({
          tx,
          vehicleId: intervention.vehicleId,
          tenantId,
          userId: user.id,
          ...(user.locationId ? { locationId: user.locationId } : {}),
          action: 'respond',
          ipAddress: request.ip,
          log: request.log,
        });

        return {
          disputes: respondedDisputes,
          interventionStatus,
        };
      });
    },
  );
};

export default interventionDisputeResponseRoutes;
