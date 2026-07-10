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

// GET /v1/vehicles/:id/export.pdf — officina full vehicle-history PDF (v1.1).
// APPENDICE_A reserved this path for the workshop surface; the customer variant
// lives at /me/vehicles/:id/export.pdf (stays cross-officina — do not touch it).
// Renders in-Lambda and streams the bytes directly — no S3 persist, no presigned URL.
//
// BR-150/BR-153 (the shared cross-tenant logbook) is deprecated for the officina
// surface as of 2026-07-09: the shared logbook is now customer-facing only. This
// route is therefore ALWAYS scoped to the caller's own tenant — access is gated by
// vehicle existence (404 vehicle.not_found) plus the app-layer tenantId filter below
// (the security frontier, never RLS alone).
//   show_names   — grouped-by-officina headers (true) vs anonymous flat list (false),
//                  rendered over own-tenant data only.
// Only active+disputed are included (cancelled excluded, BR-150). internal_notes and
// owner PII are never selected — customer-deliverable document, neutral header.

const querySchema = z.object({
  show_names: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

const vehicleExportPdfRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/vehicles/:id/export.pdf',
    { preHandler: [requireAuth, requireOfficinaPool, tenantContext] },
    async (request, reply) => {
      const { id: vehicleId } = idParamSchema.parse(request.params);
      const { show_names: showNames } = querySchema.parse(request.query);
      const tenantId = request.tenantId!;

      const pdfData = await app.withContext({ tenantId, role: 'user' as const }, async (tx) => {
        const vehicle = await tx.vehicle.findUnique({
          where: { id: vehicleId },
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
        });
        if (!vehicle) {
          throw businessError('vehicle.not_found', 404, 'Veicolo non trovato.');
        }

        // Always scoped to the caller's own tenant (BR-150/BR-153 deprecated
        // 2026-07-09), see header comment.
        const interventions = await tx.intervention.findMany({
          where: {
            vehicleId,
            status: { in: ['active', 'disputed'] },
            tenantId,
          },
          orderBy: [{ interventionDate: 'desc' }, { id: 'desc' }],
          select: {
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
          },
        });

        const data: VehicleHistoryPdfData = {
          vehicle,
          generatedAt: new Date().toISOString().slice(0, 10),
          mode: showNames ? 'grouped' : 'anonymous',
          interventions: interventions.map((it) => ({
            interventionDate: it.interventionDate.toISOString().slice(0, 10),
            odometerKm: it.odometerKm,
            typeName: it.interventionType.nameIt,
            tenantName: it.tenant.businessName,
            tenantId: it.tenantId,
            // BR-303/308: frozen snapshot labels, sorted by the shared serializer.
            checklistItems: serializeChecklistItems(it.checklistSelections).map((c) => c.label),
            description: it.description,
            partsReplaced: normalizePartsReplaced(it.partsReplaced),
          })),
        };
        return data;
      });

      let pdfBuffer: Buffer;
      try {
        pdfBuffer = await renderVehicleHistoryPdf(pdfData);
      } catch (err) {
        request.log.error({ err }, 'vehicle_history_pdf.render_failed');
        throw businessError(
          'vehicle_history_pdf.render_failed',
          502,
          'Generazione del PDF non riuscita.',
        );
      }

      request.log.info(
        { vehicleId, tenantId, showNames },
        'vehicle_history_pdf.officina_generated',
      );

      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `inline; filename="storico-${vehicleId}.pdf"`)
        .send(pdfBuffer);
    },
  );
};

export default vehicleExportPdfRoutes;
