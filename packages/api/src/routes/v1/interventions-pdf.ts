import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { businessError } from '../../lib/business-error.js';
import { normalizePartsReplaced, serializeChecklistItems } from '../../lib/intervention-shared.js';
import {
  renderVehicleHistoryPdf,
  type VehicleHistoryPdfData,
} from '../../lib/vehicle-history-pdf-renderer.js';
import { idParamSchema } from '../../lib/vehicle-shared.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

// GET /v1/interventions/:id/pdf — F-OFF-309.
// Renders a single-intervention PDF and streams the bytes back directly — no S3
// persist, no presigned URL.
//
// The document is the SAME as the bulk vehicle-history export
// (`renderVehicleHistoryPdf`), the only difference being it contains just the
// one referenced intervention (decided 2026-07-10). It therefore shares the
// bulk layout: neutral "STORICO MANUTENZIONE VEICOLO" / GarageOS header, no
// officina letterhead, no customer PII, no operator — a customer-deliverable
// document. `internal_notes` are never selected.
//   show_names=true  → grouped mode: the officina name is printed as a group header.
//   show_names=false → anonymous mode: no officina label anywhere.
//
// Scoping mirrors interventions-detail.ts: findFirst {id, tenantId} + null→404
// (interventions SELECT is permissive cross-tenant since migration 0003, so this
// app-layer {id, tenantId} filter is the real security frontier — never RLS alone).

const querySchema = z.object({
  show_names: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

const interventionPdfSelect = {
  interventionDate: true,
  odometerKm: true,
  description: true,
  partsReplaced: true,
  tenantId: true,
  checklistSelections: {
    select: { checklistItemId: true, labelSnapshot: true, sortOrderSnapshot: true },
    orderBy: [{ sortOrderSnapshot: 'asc' as const }, { labelSnapshot: 'asc' as const }],
  },
  interventionType: { select: { nameIt: true } },
  tenant: { select: { businessName: true } },
  vehicle: {
    select: {
      plate: true,
      make: true,
      model: true,
      version: true,
      garageCode: true,
      vin: true,
      year: true,
      fuelType: true,
    },
  },
};

const interventionPdfRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/interventions/:id/pdf',
    { preHandler: [requireAuth, requireOfficinaPool, tenantContext] },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const { show_names: showNames } = querySchema.parse(request.query);
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

        const data: VehicleHistoryPdfData = {
          vehicle: row.vehicle,
          generatedAt: new Date().toISOString().slice(0, 10),
          mode: showNames ? 'grouped' : 'anonymous',
          interventions: [
            {
              interventionDate: row.interventionDate.toISOString().slice(0, 10),
              odometerKm: row.odometerKm,
              typeName: row.interventionType.nameIt,
              tenantName: row.tenant.businessName,
              tenantId: row.tenantId,
              // BR-303/308: frozen snapshot labels, sorted by the shared serializer.
              checklistItems: serializeChecklistItems(row.checklistSelections).map((c) => c.label),
              description: row.description,
              partsReplaced: normalizePartsReplaced(row.partsReplaced),
            },
          ],
        };
        return data;
      });

      let pdfBuffer: Buffer;
      try {
        pdfBuffer = await renderVehicleHistoryPdf(pdfData);
      } catch (err) {
        request.log.error({ err }, 'intervention_pdf.render_failed');
        throw businessError(
          'intervention_pdf.render_failed',
          502,
          'Generazione del PDF non riuscita.',
        );
      }

      request.log.info({ interventionId: id, tenantId, showNames }, 'intervention_pdf.generated');

      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `inline; filename="intervento-${id}.pdf"`)
        .send(pdfBuffer);
    },
  );
};

export default interventionPdfRoutes;
