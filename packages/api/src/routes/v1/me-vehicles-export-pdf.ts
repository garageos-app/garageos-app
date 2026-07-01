import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { businessError } from '../../lib/business-error.js';
import { normalizePartsReplaced } from '../../lib/intervention-shared.js';
import {
  renderVehicleHistoryPdf,
  type VehicleHistoryPdfData,
} from '../../lib/vehicle-history-pdf-renderer.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireClientiPool } from '../../middleware/require-clienti-pool.js';
import { clientiContext } from '../../middleware/clienti-context.js';

// GET /v1/me/vehicles/:id/export.pdf — F-CLI-501. Renders the full shop-history
// PDF (active + disputed interventions across all tenants, BR-150) for a
// vehicle the authenticated customer currently owns, in-Lambda, and streams
// the bytes back directly — no S3 persist, no presigned URL.
//
// Path diverges from APPENDICE_A (`/vehicles/:id/export.pdf`): we use the
// `/me/...` customer surface for consistency with the rest of the customer app
// (same call as POST /me/vehicles/claim, #159).
//
// Auth chain mirrors me-vehicles.ts. The security boundary is the app-layer
// ownership gate (vehicleOwnership endedAt=null, BR-040) — never RLS alone
// (#154). cancelled interventions are excluded; internal_notes are not selected.

const idParamSchema = z.object({ id: z.uuid() });

const meVehicleExportPdfRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/me/vehicles/:id/export.pdf',
    { preHandler: [requireAuth, requireClientiPool, clientiContext] },
    async (request, reply) => {
      const { id: vehicleId } = idParamSchema.parse(request.params);
      const customerId = request.customerId!;

      const pdfData = await app.withContext({ customerId, role: 'user' as const }, async (tx) => {
        // BR-040 ownership gate (the security frontier, never RLS alone).
        const ownership = await tx.vehicleOwnership.findFirst({
          where: { vehicleId, customerId, endedAt: null },
          select: {
            vehicle: {
              select: {
                id: true,
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
          },
        });
        if (!ownership) {
          throw businessError(
            'me.vehicle.not_found',
            404,
            'Veicolo non trovato o non più di tua proprietà.',
          );
        }

        // Shop interventions, cross-tenant (BR-150), shop-only statuses.
        const interventions = await tx.intervention.findMany({
          where: { vehicleId, status: { in: ['active', 'disputed'] } },
          orderBy: [{ interventionDate: 'desc' }, { id: 'desc' }],
          select: {
            interventionDate: true,
            odometerKm: true,
            title: true,
            description: true,
            partsReplaced: true,
            interventionType: { select: { nameIt: true } },
            tenant: { select: { businessName: true } },
          },
        });

        const v = ownership.vehicle;
        const data: VehicleHistoryPdfData = {
          vehicle: {
            plate: v.plate,
            make: v.make,
            model: v.model,
            version: v.version,
            garageCode: v.garageCode,
            vin: v.vin,
            year: v.year,
            fuelType: v.fuelType,
          },
          generatedAt: new Date().toISOString().slice(0, 10),
          interventions: interventions.map((it) => ({
            interventionDate: it.interventionDate.toISOString().slice(0, 10),
            odometerKm: it.odometerKm,
            typeName: it.interventionType.nameIt,
            tenantName: it.tenant.businessName,
            title: it.title,
            description: it.description,
            partsReplaced: normalizePartsReplaced(it.partsReplaced),
          })),
        };
        return data;
      });

      let pdfBuffer: Buffer;
      try {
        pdfBuffer = await renderVehicleHistoryPdf(pdfData);
      } catch {
        throw businessError(
          'vehicle_history_pdf.render_failed',
          502,
          'Generazione del PDF non riuscita.',
        );
      }

      request.log.info({ vehicleId, customerId }, 'vehicle_history_pdf.generated');

      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `inline; filename="storico-${vehicleId}.pdf"`)
        .send(pdfBuffer);
    },
  );
};

export default meVehicleExportPdfRoutes;
