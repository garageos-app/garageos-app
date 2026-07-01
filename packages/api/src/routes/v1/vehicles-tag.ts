import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';

import { businessError } from '../../lib/business-error.js';
import { renderTagPdf } from '../../lib/vehicle-tag-renderer.js';
import { VehicleTagAuditInsertFailedError } from '../../lib/vehicle-tag-errors.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

// GET /v1/vehicles/:id/tag — F-OFF-104
// Renders the vehicle's PDF tag in-Lambda and streams the bytes back
// directly — no S3 persist, no presigned URL.
//
// BR-026: Tag PDF is immutable and deterministic (only garageCode affects
//   the render — see vehicle-tag-renderer.js), so re-rendering on every call
//   is cheap and needs no cache.
//
// Status guard:
//   - 'archived'  → 409 vehicle.archived   (tag unavailable for archived vehicles)
//   - 'pending'   → 409 vehicle.not_certified (tag only available once certified)
//   - 'certified'  → 200 (proceed to render + audit)
//
// Every successful call inserts a VehicleTagPrint audit row with kind='first'.

const paramsSchema = z.object({
  id: z.string().uuid(),
});

const vehicleTagRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/vehicles/:id/tag',
    { preHandler: [requireAuth, requireOfficinaPool, tenantContext] },
    async (request, reply) => {
      const parsed = paramsSchema.safeParse(request.params);
      if (!parsed.success) {
        throw businessError('VALIDATION_ERROR', 400, 'ID veicolo non valido');
      }
      const { id: vehicleId } = parsed.data;
      const tenantId = request.tenantId!;
      const cognitoSub = request.userId!;

      const { pdfBuffer, garageCode } = await app.withContext(
        { tenantId, role: 'user' as const },
        async (tx) => {
          // 1. Fetch vehicle — scope to tenant for deterministic isolation.
          //    Vehicle has no direct tenantId field; ownership is expressed
          //    via createdByTenantId (pending/certified) or certifiedByTenantId
          //    (certified post-transfer). Mirror vehicles-ownership-transfer.ts
          //    pattern exactly (feedback_prisma_loose_where_silently_drops_unknown_keys).
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

          // See BR-026: tag only available for certified vehicles.
          // Archived check is explicit (specific code); positive certified guard
          // catches any future non-certified status (e.g. pending, suspended).
          if (vehicle.status === 'archived') {
            throw businessError(
              'vehicle.archived',
              409,
              'Il tag non è disponibile per veicoli archiviati',
            );
          }
          if (vehicle.status !== 'certified') {
            // pending and any future non-certified status → not_certified
            throw businessError(
              'vehicle.not_certified',
              409,
              'Il tag è disponibile solo per veicoli certificati',
            );
          }

          // At this point garageCode is guaranteed non-null (certified vehicle
          // must have a garage code assigned at certification — BR-020/BR-022).
          // The null guard below is a defensive assertion only; it should never
          // be reached in practice.
          if (!vehicle.garageCode) {
            throw businessError(
              'vehicle.not_certified',
              409,
              'Il tag è disponibile solo per veicoli certificati',
            );
          }
          const garageCode = vehicle.garageCode;

          // 2. Resolve the DB user.id from the Cognito sub.
          //    request.userId carries the Cognito sub (opaque string), NOT the DB
          //    users.id UUID. The FK printed_by_user_id references users.id, so we
          //    must look up the row first — same pattern as users-update.ts / users-avatar.ts.
          const userRow = await tx.user.findFirstOrThrow({
            where: { cognitoSub, tenantId },
            select: { id: true },
          });

          // 3. Render the tag PDF. Rendering happens before the audit insert
          //    so a render failure never leaves an orphan audit row.
          let pdfBuffer: Buffer;
          try {
            pdfBuffer = await renderTagPdf(garageCode);
          } catch (err) {
            request.log.error({ err }, 'vehicle_tag.render_failed');
            throw businessError(
              'vehicle_tag.render_failed',
              502,
              'Generazione del tag non riuscita.',
            );
          }

          // 4. Audit row — every print event is recorded.
          try {
            await tx.vehicleTagPrint.create({
              data: {
                vehicleId,
                tenantId,
                printedByUserId: userRow.id,
                kind: 'first',
              },
            });
          } catch (err) {
            throw new VehicleTagAuditInsertFailedError('audit insert failed', err);
          }

          request.log.info(
            { vehicleId, garageCode, userId: userRow.id, kind: 'first' },
            'tag.printed',
          );

          return { pdfBuffer, garageCode };
        },
      );

      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `inline; filename="tag-${garageCode}.pdf"`)
        .send(pdfBuffer);
    },
  );
};

export default vehicleTagRoutes;
