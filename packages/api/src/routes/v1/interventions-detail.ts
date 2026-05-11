import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { businessError } from '../../lib/business-error.js';
import { isWikiWindowOpen } from '../../lib/intervention-shared.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

// GET /v1/interventions/:id — officina-pool detail endpoint (F-OFF-301).
//
// RLS topology: interventions SELECT is permissive cross-tenant since
// migration 0003 (split SELECT/WRITE). Use findFirst with explicit
// {id, tenantId} + null check → 404. Do NOT use findUniqueOrThrow:
// it would surface cross-tenant rows then trip our null check with the
// wrong code shape, leaking existence. Same pattern as
// interventions-disputes-list.ts.
//
// wiki_window_open is server-computed (BR-062 composite predicate with
// time component — see feedback_compute_composite_br_predicates_server_side.md).

const paramsSchema = z.object({ id: z.uuid() });

const interventionDetailSelect = {
  id: true,
  status: true,
  interventionDate: true,
  odometerKm: true,
  title: true,
  description: true,
  internalNotes: true,
  partsReplaced: true,
  wikiLockedAt: true,
  firstSeenByCustomerAt: true,
  createdAt: true,
  cancelledAt: true,
  cancelledReason: true,
  interventionType: { select: { id: true, code: true, nameIt: true } },
  tenant: { select: { id: true, businessName: true } },
  location: {
    select: { id: true, name: true, city: true, addressLine: true },
  },
  vehicle: {
    select: { id: true, garageCode: true, plate: true, make: true, model: true },
  },
  user: { select: { id: true, firstName: true, lastName: true } },
} as const;

interface PartReplaced {
  brand: string | null;
  code: string | null;
  description: string;
  quantity: number;
}

function normalizePartsReplaced(value: unknown): PartReplaced[] {
  if (!Array.isArray(value)) return [];
  return value.map((p) => {
    const o = (p ?? {}) as Record<string, unknown>;
    return {
      brand: typeof o.brand === 'string' ? o.brand : null,
      code: typeof o.code === 'string' ? o.code : null,
      description: typeof o.description === 'string' ? o.description : '',
      quantity: typeof o.quantity === 'number' ? o.quantity : 1,
    };
  });
}

const interventionDetailRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/interventions/:id',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request) => {
      const { id } = paramsSchema.parse(request.params);
      const tenantId = request.tenantId!;

      return app.withContext({ tenantId }, async (tx) => {
        const row = await tx.intervention.findFirst({
          where: { id, tenantId },
          select: interventionDetailSelect,
        });

        if (!row) {
          throw businessError(
            'intervention.not_found',
            404,
            'Intervento non trovato o non accessibile da questa officina.',
          );
        }

        // Attachments use the polymorphic ownerType/ownerId pattern — the
        // Intervention model has no direct Prisma relation to Attachment.
        // Fetch separately after the tenant-scoped intervention lookup so
        // the intervention-not-found guard runs first.
        const attachments = await tx.attachment.findMany({
          where: {
            ownerType: 'intervention',
            ownerId: id,
            processed: true,
            deletedAt: null,
          },
          select: {
            id: true,
            fileName: true,
            mimeType: true,
            sizeBytes: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'asc' },
        });

        const now = new Date();

        return {
          id: row.id,
          status: row.status,
          is_disputed: row.status === 'disputed',
          wiki_window_open: isWikiWindowOpen(
            row.wikiLockedAt,
            row.firstSeenByCustomerAt,
            row.createdAt,
            now,
          ),
          intervention_date: row.interventionDate.toISOString().slice(0, 10),
          odometer_km: row.odometerKm,
          created_at: row.createdAt.toISOString(),
          cancelled_at: row.cancelledAt?.toISOString() ?? null,
          cancelled_reason: row.cancelledReason,
          title: row.title,
          description: row.description,
          internal_notes: row.internalNotes,
          parts_replaced: normalizePartsReplaced(row.partsReplaced),
          type: {
            id: row.interventionType.id,
            code: row.interventionType.code,
            name_it: row.interventionType.nameIt,
          },
          tenant: { id: row.tenant.id, business_name: row.tenant.businessName },
          location: {
            id: row.location.id,
            name: row.location.name,
            city: row.location.city,
            address: row.location.addressLine,
          },
          vehicle: {
            id: row.vehicle.id,
            garage_code: row.vehicle.garageCode,
            plate: row.vehicle.plate,
            make: row.vehicle.make,
            model: row.vehicle.model,
          },
          created_by: row.user
            ? {
                id: row.user.id,
                first_name: row.user.firstName,
                last_name: row.user.lastName,
              }
            : null,
          attachments: attachments.map((a) => ({
            id: a.id,
            file_name: a.fileName,
            mime_type: a.mimeType,
            size_bytes: a.sizeBytes,
            created_at: a.createdAt.toISOString(),
          })),
        };
      });
    },
  );
};

export default interventionDetailRoutes;
