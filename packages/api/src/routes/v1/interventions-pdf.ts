import type { FastifyPluginAsync } from 'fastify';

import { env } from '../../config/env.js';
import { businessError } from '../../lib/business-error.js';
import { generateInterventionPdfPresignedUrl } from '../../lib/intervention-pdf-s3.js';
import { normalizePartsReplaced } from '../../lib/intervention-shared.js';
import { resolvePiiVisibility } from '../../lib/pii-filter.js';
import { resolveTenantLogo } from '../../lib/tenant-logo.js';
import { idParamSchema } from '../../lib/vehicle-shared.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

// GET /v1/interventions/:id/pdf — F-OFF-309.
// Renders a single-intervention PDF (officina header + vehicle + owner +
// details), persists it to S3, returns a 1h presigned download URL.
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
  title: true,
  description: true,
  partsReplaced: true,
  cancelledReason: true,
  interventionType: { select: { nameIt: true } },
  tenant: {
    select: {
      businessName: true,
      addressLine: true,
      city: true,
      vatNumber: true,
      phone: true,
      logoUrl: true,
    },
  },
  vehicle: { select: { id: true, plate: true, make: true, model: true, garageCode: true } },
  user: { select: { firstName: true, lastName: true } },
} as const;

const interventionPdfRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/interventions/:id/pdf',
    { preHandler: [requireAuth, requireOfficinaPool, tenantContext] },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const tenantId = request.tenantId!;

      return app.withContext({ tenantId, role: 'user' as const }, async (tx) => {
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

        const logo = await resolveTenantLogo(env.S3_ATTACHMENTS_BUCKET, row.tenant.logoUrl);

        // Prisma's InterventionStatus enum is an opaque cross-package brand; the
        // renderer intentionally stays DB-decoupled with a plain string union, so
        // we narrow here at the boundary. KEEP IN SYNC: if InterventionStatus gains
        // a member, update the renderer's InterventionPdfData.status union too.
        const { url, expiresAt } = await generateInterventionPdfPresignedUrl({
          bucket: env.S3_ATTACHMENTS_BUCKET,
          tenantId,
          interventionId: row.id,
          logo,
          data: {
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
            title: row.title,
            description: row.description,
            partsReplaced: normalizePartsReplaced(row.partsReplaced),
            operatorName,
            status: row.status as 'active' | 'disputed' | 'cancelled',
            cancelledReason: row.cancelledReason,
          },
        });

        request.log.info({ interventionId: row.id, tenantId }, 'intervention_pdf.generated');

        return { pdf_download_url: url, expires_at: expiresAt.toISOString() };
      });
    },
  );
};

export default interventionPdfRoutes;
