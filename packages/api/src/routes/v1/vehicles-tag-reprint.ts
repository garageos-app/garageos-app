import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { env } from '../../config/env.js';
import { businessError } from '../../lib/business-error.js';
import {
  getOrCreateTagPresignedUrl,
  VehicleTagAuditInsertFailedError,
} from '../../lib/vehicle-tag-s3.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

// POST /v1/vehicles/:id/tag-reprint — F-OFF-109 PR2 (ristampa tag).
//
// Riusa S3 cache PR1 (PDF immutabile per BR-022, cache-hit garantito post
// audit-count check). Inserisce un audit row con kind='reprint', reason,
// reason_note, document_verified=true.
//
// Status guard (stesse regole di vehicles-tag.ts):
//   - 'archived'  → 409 vehicle.archived
//   - non-certified → 409 vehicle.not_certified
//   - 'certified'  → procedi
//
// Gating specifico per ristampa (BR-028):
//   - auditCount === 0  → 409 vehicle_tag.never_printed
//   - documentVerified === false → 400 VALIDATION_ERROR (Zod z.literal(true))
//   - reason='other' senza reasonNote → 400 VALIDATION_ERROR (Zod .refine)

const paramsSchema = z.object({
  id: z.string().uuid(),
});

const bodySchema = z
  .object({
    reason: z.enum(['lost', 'damaged', 'other']),
    reasonNote: z.string().min(3).max(500).optional(),
    // See BR-028: document must be verified before reprint is allowed.
    // z.literal(true) rejects false/missing without a custom message.
    documentVerified: z.literal(true),
  })
  .refine(
    (data) => data.reason !== 'other' || (data.reasonNote != null && data.reasonNote.length >= 3),
    { message: 'reasonNote obbligatoria quando reason è "other"', path: ['reasonNote'] },
  );

const vehicleTagReprintRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/v1/vehicles/:id/tag-reprint',
    { preHandler: [requireAuth, requireOfficinaPool, tenantContext] },
    async (request) => {
      const parsed = paramsSchema.safeParse(request.params);
      if (!parsed.success) {
        throw businessError('VALIDATION_ERROR', 400, 'ID veicolo non valido');
      }
      const { id: vehicleId } = parsed.data;

      const body = bodySchema.parse(request.body);
      const tenantId = request.tenantId!;
      const cognitoSub = request.userId!;

      return app.withContext({ tenantId, role: 'user' as const }, async (tx) => {
        // 1. Fetch vehicle — scope to tenant via OR pattern (Vehicle has no
        //    direct tenantId field — feedback_prisma_loose_where_silently_drops_unknown_keys).
        const vehicle = await tx.vehicle.findFirst({
          where: {
            id: vehicleId,
            OR: [{ certifiedByTenantId: tenantId }, { createdByTenantId: tenantId }],
          },
          select: { id: true, garageCode: true, status: true },
        });

        if (!vehicle) {
          throw businessError('vehicle.not_found', 404, 'Veicolo non trovato');
        }

        // Status guard mirrors vehicles-tag.ts exactly.
        if (vehicle.status === 'archived') {
          throw businessError(
            'vehicle.archived',
            409,
            'Il tag non è disponibile per veicoli archiviati',
          );
        }
        if (vehicle.status !== 'certified') {
          throw businessError(
            'vehicle.not_certified',
            409,
            'Il tag è disponibile solo per veicoli certificati',
          );
        }

        // Defensive null-guard: certified vehicles always have a garageCode
        // (BR-020/BR-022), but guard explicitly to satisfy TypeScript strict.
        if (!vehicle.garageCode) {
          throw businessError(
            'vehicle.not_certified',
            409,
            'Il tag è disponibile solo per veicoli certificati',
          );
        }
        const garageCode = vehicle.garageCode;

        // 2. Ristampa gating (BR-028): il tag deve essere già stato stampato
        //    almeno una volta. Count anziché findFirst per evitare di leggere
        //    dati non necessari.
        const auditCount = await tx.vehicleTagPrint.count({
          where: { vehicleId: vehicle.id },
        });
        if (auditCount === 0) {
          throw businessError(
            'vehicle_tag.never_printed',
            409,
            'Il tag deve essere stampato almeno una volta prima della ristampa',
          );
        }

        // 3. Resolve DB user.id from Cognito sub — same pattern as vehicles-tag.ts.
        const userRow = await tx.user.findFirstOrThrow({
          where: { cognitoSub, tenantId },
          select: { id: true },
        });

        // 4. Generate / retrieve presigned URL (lazy S3 cache — BR-026).
        //    Cache-hit is guaranteed here because auditCount > 0 implies a
        //    prior successful first print which uploaded the PDF.
        const { url, expiresAt } = await getOrCreateTagPresignedUrl({
          bucket: env.S3_ATTACHMENTS_BUCKET,
          garageCode,
        });

        // 5. Audit row with kind='reprint' — every reprint event is recorded.
        try {
          await tx.vehicleTagPrint.create({
            data: {
              vehicleId: vehicle.id,
              tenantId,
              printedByUserId: userRow.id,
              kind: 'reprint',
              reason: body.reason,
              reasonNote: body.reasonNote ?? null,
              documentVerified: true,
            },
          });
        } catch (err) {
          throw new VehicleTagAuditInsertFailedError('audit insert failed', err);
        }

        request.log.info(
          {
            vehicleId: vehicle.id,
            garageCode,
            userId: userRow.id,
            kind: 'reprint',
            reason: body.reason,
            reasonNoteLen: body.reasonNote?.length ?? 0,
          },
          'tag.reprinted',
        );

        return {
          tag_download_url: url,
          expires_at: expiresAt.toISOString(),
        };
      });
    },
  );
};

export default vehicleTagReprintRoutes;
