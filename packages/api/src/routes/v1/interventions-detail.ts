import type { FastifyPluginAsync } from 'fastify';

import { businessError } from '../../lib/business-error.js';
import { isWikiWindowOpen, normalizePartsReplaced } from '../../lib/intervention-shared.js';
import { idParamSchema } from '../../lib/vehicle-shared.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

// GET /v1/interventions/:id — officina-pool detail endpoint (F-OFF-301).
//
// Visibility (BR-150 / BR-153): the shop intervention history is readable
// cross-tenant — any officina can open another tenant's intervention in
// read-only mode (shared maintenance logbook). RLS `interventions_read` is
// permissive cross-tenant since migration 0003, so the lookup is a plain
// findFirst({id}) + null check → 404 only when the row truly does not exist.
//
// Reserved fields are redacted when the requesting tenant is NOT the owner:
//   - internal_notes → null  (BR-153 "note riservate di altri tenant")
//   - created_by     → null  (mechanic identity gated by BR-151; the
//                             timeline never exposes it cross-tenant either)
// `viewer_is_owner` is surfaced so the web client can hide edit/dispute
// affordances (those mutations remain owner-only) and show a read-only
// banner. This aligns §2.12 of APPENDICE_A with BR-153.
//
// wiki_window_open is server-computed (BR-062 composite predicate with
// time component — see feedback_compute_composite_br_predicates_server_side.md).

const interventionDetailSelect = {
  id: true,
  tenantId: true,
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

const interventionDetailRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/interventions/:id',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const tenantId = request.tenantId!;
      const now = new Date();

      return app.withContext({ tenantId, role: 'user' as const }, async (tx) => {
        const row = await tx.intervention.findFirst({
          where: { id },
          select: interventionDetailSelect,
        });

        if (!row) {
          throw businessError('intervention.not_found', 404, 'Intervento non trovato.');
        }

        // BR-150 / BR-153: an officina that did not create the intervention
        // gets a read-only, redacted view. Drives the redaction below.
        const isOwner = row.tenantId === tenantId;

        // Attachments use the polymorphic ownerType/ownerId pattern — the
        // Intervention model has no direct Prisma relation to Attachment.
        // Fetch separately after the intervention lookup so the not-found
        // guard runs first. Scope to the *owning* tenant (row.tenantId), not
        // the caller: attachments belong to the intervention's tenant and
        // stay visible cross-tenant (part of the shared shop record), while
        // the explicit tenant scope still bounds the polymorphic query.
        const attachments = await tx.attachment.findMany({
          where: {
            ownerType: 'intervention',
            ownerId: id,
            tenantId: row.tenantId,
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
          // BR-153: reserved notes are hidden from non-owning tenants.
          internal_notes: isOwner ? row.internalNotes : null,
          viewer_is_owner: isOwner,
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
          // BR-151: mechanic identity is gated by the tenant relation, so
          // non-owning tenants never see who created the record.
          created_by:
            isOwner && row.user
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
