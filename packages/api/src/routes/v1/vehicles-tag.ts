import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';

import { businessError } from '../../lib/business-error.js';
import { getOrCreateTagPresignedUrl } from '../../lib/vehicle-tag-s3.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';
import { env } from '../../config/env.js';

// GET /v1/vehicles/:id/tag — F-OFF-104
// Returns a 1-hour presigned S3 URL for the vehicle's PDF tag.
//
// BR-026: Tag PDF is immutable, lazy-generated and cached at
//   S3 key `tags/<garage_code>.pdf`. The helper getOrCreateTagPresignedUrl
//   performs a HeadObject check before generating/uploading.
//
// Status guard:
//   - 'archived'  → 409 vehicle.archived   (tag unavailable for archived vehicles)
//   - 'pending'   → 409 vehicle.not_certified (tag only available once certified)
//   - 'active'    → 200 (proceed to presign + audit)
//
// Every successful call inserts a VehicleTagPrint audit row with kind='first'.

const paramsSchema = z.object({
  id: z.string().uuid(),
});

const vehicleTagRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/vehicles/:id/tag',
    { preHandler: [requireAuth, requireOfficinaPool, tenantContext] },
    async (request) => {
      const parsed = paramsSchema.safeParse(request.params);
      if (!parsed.success) {
        throw businessError('VALIDATION_ERROR', 400, 'ID veicolo non valido');
      }
      const { id: vehicleId } = parsed.data;
      const tenantId = request.tenantId!;
      const userId = request.userId!;

      return app.withContext({ tenantId, role: 'user' as const }, async (tx) => {
        // 1. Fetch vehicle — scope to tenant for deterministic isolation
        //    (defensive pattern consistent with BR-151 RLS split
        //    feedback_rls_split_changes_endpoint_semantics).
        const vehicle = await tx.vehicle.findFirst({
          where: { id: vehicleId, tenantId },
          select: { id: true, garageCode: true, status: true },
        });

        if (!vehicle) {
          throw businessError('vehicle.not_found', 404, 'Veicolo non trovato');
        }

        // See BR-026: tag only available for certified (active) vehicles.
        if (vehicle.status === 'archived') {
          throw businessError(
            'vehicle.archived',
            409,
            'Il tag non è disponibile per veicoli archiviati',
          );
        }
        // garageCode is null when the vehicle has not yet been certified
        // (status='pending' or newly created). Both conditions map to the
        // same user-facing error: the tag is not available yet.
        if (vehicle.status === 'pending' || vehicle.garageCode === null) {
          throw businessError(
            'vehicle.not_certified',
            409,
            'Il tag è disponibile solo per veicoli certificati',
          );
        }

        // At this point garageCode is guaranteed non-null (active vehicle
        // must have a garage code assigned at certification — BR-020/BR-022).
        const garageCode = vehicle.garageCode;

        // 2. Generate / retrieve presigned URL (lazy S3 cache — BR-026).
        const { url, expiresAt, cacheHit } = await getOrCreateTagPresignedUrl({
          bucket: env.S3_ATTACHMENTS_BUCKET,
          garageCode,
        });

        // 3. Audit row — every print event is recorded.
        await tx.vehicleTagPrint.create({
          data: {
            vehicleId,
            tenantId,
            printedByUserId: userId,
            kind: 'first',
          },
        });

        request.log.info({ vehicleId, garageCode, userId, kind: 'first', cacheHit }, 'tag.printed');

        return {
          tag_download_url: url,
          expires_at: expiresAt.toISOString(),
        };
      });
    },
  );
};

export default vehicleTagRoutes;
