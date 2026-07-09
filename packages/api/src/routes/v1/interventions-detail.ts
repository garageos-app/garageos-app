import type { FastifyPluginAsync } from 'fastify';

import { businessError } from '../../lib/business-error.js';
import {
  isWikiWindowOpen,
  normalizePartsReplaced,
  serializeChecklistItems,
} from '../../lib/intervention-shared.js';
import { idParamSchema } from '../../lib/vehicle-shared.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

// GET /v1/interventions/:id — officina-pool detail endpoint (F-OFF-301).
//
// Visibility: the endpoint is scoped to the calling tenant. The lookup is
// findFirst({ id, tenantId }) — a foreign-tenant intervention is
// indistinguishable from a non-existent one and returns 404
// (intervention.not_found). RLS `interventions_read` is permissive
// cross-tenant (see migration 0003), so this app-layer `{ id, tenantId }`
// filter is the real security frontier here, not the RLS policy — never
// rely on RLS alone.
//
// No cross-tenant redaction is needed because the caller is always the
// owner: internal_notes and created_by are always populated from the row.
// `viewer_is_owner` is kept in the response, hardcoded to `true`, purely for
// shape compatibility with the currently-deployed web app that still reads
// this field; it is dropped in a later PR once the client no longer needs it.
//
// NOTE (2026-07-09): BR-150 / BR-153 (shared cross-tenant logbook with
// redaction) are being deprecated — the shared logbook is now
// customer-facing only, not shop-facing. This endpoint no longer implements
// them.
//
// wiki_window_open is server-computed (BR-062 composite predicate with
// time component — see feedback_compute_composite_br_predicates_server_side.md).
//
// BR-308: interventions no longer carry a free-text `title` — the read DTO
// drops it entirely (no input, no persistence beyond the legacy column, no
// exposure here). The heading shown to the user is the intervention type's
// name (see `type.name_it` below); `PrivateIntervention.customType` is an
// unrelated, still-intact concept (D9). Checklist items replace it as the
// itemized body of the record and are read straight from
// `checklistSelections` (label_snapshot/sort_order_snapshot) — a frozen
// snapshot, never a join on the global catalog — so a later rename or
// deletion of the catalog item (BR-303/D8) never changes what a past
// intervention displays.
const interventionDetailSelect = {
  id: true,
  tenantId: true,
  status: true,
  interventionDate: true,
  odometerKm: true,
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
  vehicle: {
    select: { id: true, garageCode: true, plate: true, make: true, model: true },
  },
  user: { select: { id: true, firstName: true, lastName: true } },
  checklistSelections: {
    select: { checklistItemId: true, labelSnapshot: true, sortOrderSnapshot: true },
    orderBy: [{ sortOrderSnapshot: 'asc' as const }, { labelSnapshot: 'asc' as const }],
  },
};

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
          where: { id, tenantId },
          select: interventionDetailSelect,
        });

        if (!row) {
          throw businessError('intervention.not_found', 404, 'Intervento non trovato.');
        }

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
          description: row.description,
          internal_notes: row.internalNotes,
          // Hardcoded true: the lookup above already scopes to the calling
          // tenant, so the caller is always the owner. Kept for response
          // shape compatibility with the deployed web app (removed in a
          // later PR).
          viewer_is_owner: true,
          parts_replaced: normalizePartsReplaced(row.partsReplaced),
          // BR-308 / BR-303: checklist items are read from the frozen
          // snapshot, not the live catalog (see comment on
          // interventionDetailSelect above).
          checklist_items: serializeChecklistItems(row.checklistSelections),
          type: {
            id: row.interventionType.id,
            code: row.interventionType.code,
            name_it: row.interventionType.nameIt,
          },
          tenant: { id: row.tenant.id, business_name: row.tenant.businessName },
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
        };
      });
    },
  );
};

export default interventionDetailRoutes;
