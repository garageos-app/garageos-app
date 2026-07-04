import type { FastifyPluginAsync } from 'fastify';

import { businessError } from '../../lib/business-error.js';
import {
  renderInterventionPdf,
  type InterventionPdfData,
} from '../../lib/intervention-pdf-renderer.js';
import { normalizePartsReplaced, serializeChecklistItems } from '../../lib/intervention-shared.js';
import { resolvePiiVisibility } from '../../lib/pii-filter.js';
import { idParamSchema } from '../../lib/vehicle-shared.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

// GET /v1/interventions/:id/pdf — F-OFF-309.
// Renders a single-intervention PDF (officina header + vehicle + owner +
// details) in-Lambda and streams the bytes back directly — no S3 persist,
// no presigned URL, no tenant logo (dropped in this slice).
//
// Scoping mirrors interventions-detail.ts: findFirst {id, tenantId} + null→404
// (interventions SELECT is permissive cross-tenant since migration 0003).
//
// BR-151: owner customerName is PII relation-gated; BR-213: operator fallback
// "Operatore"; BR-040: active owner is the VehicleOwnership with endedAt=null.
// internal_notes are intentionally NOT selected — customer-facing document.

const REDACTED_OWNER = 'Proprietario non in anagrafica'; // BR-153 literal

const interventionPdfSelect = {
  id: true,
  status: true,
  interventionDate: true,
  odometerKm: true,
  description: true,
  partsReplaced: true,
  cancelledReason: true,
  checklistSelections: {
    select: { checklistItemId: true, labelSnapshot: true, sortOrderSnapshot: true },
    orderBy: [{ sortOrderSnapshot: 'asc' as const }, { labelSnapshot: 'asc' as const }],
  },
  interventionType: { select: { nameIt: true } },
  tenant: {
    select: {
      businessName: true,
      addressLine: true,
      city: true,
      vatNumber: true,
      phone: true,
    },
  },
  vehicle: { select: { id: true, plate: true, make: true, model: true, garageCode: true } },
  user: { select: { firstName: true, lastName: true } },
};

const interventionPdfRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/interventions/:id/pdf',
    { preHandler: [requireAuth, requireOfficinaPool, tenantContext] },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const tenantId = request.tenantId!;

      const pdfData = await app.withContext({ tenantId, role: 'user' as const }, async (tx) => {
        const row = await tx.intervention.findFirst({
          where: { id, tenantId },
          select: interventionPdfSelect,
        });

        if (!row) {
          throw businessError(
            'intervention.not_found',
            404,
            'Intervento non trovato o non accessibile da questa officina.',
          );
        }

        // BR-040: active owner = ownership with endedAt null.
        const ownership = await tx.vehicleOwnership.findFirst({
          where: { vehicleId: row.vehicle.id, endedAt: null },
          select: {
            customer: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                isBusiness: true,
                businessName: true,
              },
            },
          },
        });

        // BR-151: PII relation-gated. Visible → name; not visible → placeholder.
        let customerName: string | null = null;
        const owner = ownership?.customer ?? null;
        if (owner) {
          const visible = await resolvePiiVisibility({ tx, tenantId, customerIds: [owner.id] });
          if (visible.has(owner.id)) {
            customerName =
              owner.isBusiness && owner.businessName
                ? owner.businessName
                : `${owner.firstName} ${owner.lastName}`.trim();
          } else {
            customerName = REDACTED_OWNER;
          }
        }

        // BR-213: operator fallback when the user record is absent (deleted user).
        const operatorName = row.user
          ? `${row.user.firstName} ${row.user.lastName}`.trim() || 'Operatore'
          : 'Operatore';

        // Prisma's InterventionStatus enum is an opaque cross-package brand; the
        // renderer intentionally stays DB-decoupled with a plain string union, so
        // we narrow here at the boundary. KEEP IN SYNC: if InterventionStatus gains
        // a member, update the renderer's InterventionPdfData.status union too.
        const data: InterventionPdfData = {
          tenant: {
            businessName: row.tenant.businessName,
            addressLine: row.tenant.addressLine,
            city: row.tenant.city,
            vatNumber: row.tenant.vatNumber,
            phone: row.tenant.phone,
          },
          customerName,
          vehicle: {
            plate: row.vehicle.plate,
            make: row.vehicle.make,
            model: row.vehicle.model,
            garageCode: row.vehicle.garageCode,
          },
          interventionDate: row.interventionDate.toISOString().slice(0, 10),
          odometerKm: row.odometerKm,
          typeName: row.interventionType.nameIt,
          // BR-303/308: frozen snapshot labels, sorted by the shared serializer.
          checklistItems: serializeChecklistItems(row.checklistSelections).map((c) => c.label),
          description: row.description,
          partsReplaced: normalizePartsReplaced(row.partsReplaced),
          operatorName,
          status: row.status as 'active' | 'disputed' | 'cancelled',
          cancelledReason: row.cancelledReason,
        };
        return data;
      });

      let pdfBuffer: Buffer;
      try {
        pdfBuffer = await renderInterventionPdf(pdfData, null);
      } catch (err) {
        request.log.error({ err }, 'intervention_pdf.render_failed');
        throw businessError(
          'intervention_pdf.render_failed',
          502,
          'Generazione del PDF non riuscita.',
        );
      }

      request.log.info({ interventionId: id, tenantId }, 'intervention_pdf.generated');

      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `inline; filename="intervento-${id}.pdf"`)
        .send(pdfBuffer);
    },
  );
};

export default interventionPdfRoutes;
