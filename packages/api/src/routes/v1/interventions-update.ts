import { Prisma, UpdateInterventionSchema } from '@garageos/database';
import type { FastifyPluginAsync } from 'fastify';

import { recordVehicleAccess } from '../../lib/access-log.js';
import { businessError } from '../../lib/business-error.js';
import {
  serializeChecklistItems,
  validateChecklistSelection,
  WIKI_WINDOW_MS,
} from '../../lib/intervention-shared.js';
import { dispatchNotification } from '../../lib/notifications/dispatcher.js';
import { resolveCurrentOwner } from '../../lib/notifications/recipient-resolver.js';
import type { CustomerForNotification } from '../../lib/notifications/types.js';
import { idParamSchema } from '../../lib/vehicle-shared.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

// PATCH /v1/interventions/:id (F-OFF-304). RLS interventions_write
// enforces tenant ownership; cross-tenant write falls out as P2025 →
// 404 via the shared error handler (RLS-as-404). BR-062 wiki-window
// vs post-lock behavior is computed from
// (now - createdAt, firstSeenByCustomerAt, wikiLockedAt).
// BR-064 — post-lock revision row + reason; BR-065 — 4 editable scalar
// fields (title dropped, see below); BR-128/BR-130 — disputed/cancelled
// blocked.
// BR-303/BR-308 — checklistItemIds is a 5th, non-scalar editable field:
// when present it REPLACES the full selection set for this intervention.
// Retained items (present both before and after) keep their original
// label_snapshot untouched — never re-derived from the current catalog;
// only newly-added items get a fresh snapshot. Changing interventionTypeId
// without resending checklistItemIds is rejected (Deviation #6): the old
// selections may not even belong to the new type's checklist.

const EDITABLE_KEYS = [
  'interventionTypeId',
  'description',
  'partsReplaced',
  'internalNotes',
] as const;

type LockState = { isLocked: boolean; lockedAtToPersist: Date | null };

// BR-062: a wiki window is open while
//   wiki_locked_at IS NULL
//   AND now - created_at < 48h
//   AND first_seen_by_customer_at IS NULL.
// As soon as one age/seen condition fires, we persist
// wiki_locked_at = now() in the same UPDATE — a one-way state, never
// reversed. If wiki_locked_at is already set, we skip the persist
// (idempotent).
function computeLockState(
  existing: {
    wikiLockedAt: Date | null;
    firstSeenByCustomerAt: Date | null;
    createdAt: Date;
  },
  now: Date,
): LockState {
  if (existing.wikiLockedAt !== null) {
    return { isLocked: true, lockedAtToPersist: null };
  }
  const ageMs = now.getTime() - existing.createdAt.getTime();
  const ageGate = ageMs >= WIKI_WINDOW_MS;
  const seenGate = existing.firstSeenByCustomerAt !== null;
  if (ageGate || seenGate) {
    return { isLocked: true, lockedAtToPersist: now };
  }
  return { isLocked: false, lockedAtToPersist: null };
}

// Cheap structural equality for diff suppression. partsReplaced is an
// arbitrary JSON array; JSON-stringify is good enough here because we
// only compare canonicalized values that came either from the DB or
// from a Zod-parsed body — both produce stable orderings for our
// schema's keys.
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function buildChangesJson(
  existing: Record<string, unknown>,
  body: Record<string, unknown>,
): Record<string, { from: unknown; to: unknown }> {
  const fields = ['interventionTypeId', 'description', 'partsReplaced', 'internalNotes'];
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of fields) {
    if (body[k] === undefined) continue;
    if (valuesEqual(existing[k], body[k])) continue;
    changes[k] = { from: existing[k], to: body[k] };
  }
  return changes;
}

const interventionUpdateRoutes: FastifyPluginAsync = async (app) => {
  app.patch(
    '/v1/interventions/:id',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const body = UpdateInterventionSchema.parse(request.body);
      const tenantId = request.tenantId!;
      const cognitoSub = request.userId!;

      const result = await app.withContext({ tenantId }, async (tx) => {
        // (cognitoSub, tenantId) lookup post-0004 — see users.ts header.
        const user = await tx.user.findFirstOrThrow({
          where: { cognitoSub, tenantId },
          select: { id: true },
        });

        const existing = await tx.intervention.findUniqueOrThrow({
          where: { id },
          select: {
            tenantId: true,
            status: true,
            vehicleId: true,
            createdAt: true,
            wikiLockedAt: true,
            firstSeenByCustomerAt: true,
            interventionTypeId: true,
            description: true,
            partsReplaced: true,
            internalNotes: true,
          },
        });

        // BR-130: a cancelled intervention is read-only forever — there
        // is no "uncancel" path; correcting an error means logging a
        // new intervention. BR-128: disputed status blocks modifications
        // until the workshop responds via dispute-response (F-OFF-602).
        if (existing.status === 'cancelled') {
          throw businessError(
            'intervention.modification.cancelled',
            422,
            'Intervento cancellato: non modificabile.',
          );
        }
        if (existing.status === 'disputed') {
          throw businessError(
            'intervention.modification.disputed',
            422,
            'Intervento contestato: non modificabile finché non rispondi alla dispute.',
          );
        }

        const now = new Date();
        const lockState = computeLockState(existing, now);

        // BR-064: post-lock writes require a reason. Zod already enforces
        // length when reason is present (>= 10, <= 2000); the undefined
        // case is the gap to cover here. The `< 10` defensive belt is
        // redundant in the typical flow but cheap.
        if (lockState.isLocked && (body.reason === undefined || body.reason.length < 10)) {
          throw businessError(
            'intervention.modification.revision_reason_required',
            400,
            'Modifica post-lock: serve una motivazione di almeno 10 caratteri.',
          );
        }

        // BR-303/Deviation #6: the effective type this PATCH resolves to —
        // the new one if interventionTypeId is part of the body, otherwise
        // the intervention's current type. The checklist replace block
        // below validates candidate items against THIS id, not the raw
        // body value, so a type-change + checklistItemIds combo is scoped
        // correctly in one pass.
        const effectiveTypeId = body.interventionTypeId ?? existing.interventionTypeId;

        // FK validation on type change. Cross-tenant + system NULL types
        // are visible via RLS; an unknown id surfaces as P2025 → 404
        // NOT_FOUND via the global handler. Mirrors POST /interventions.
        // MUST run BEFORE the Deviation #6 guard below: a non-existent type
        // id is a 404 (type not found), not the 400 "re-pick checklist" —
        // this preserves the pre-existing PATCH contract and keeps parity
        // with POST create's bogus-type behavior.
        if (
          body.interventionTypeId !== undefined &&
          body.interventionTypeId !== existing.interventionTypeId
        ) {
          await tx.interventionType.findUniqueOrThrow({
            where: { id: body.interventionTypeId },
            select: { id: true },
          });
        }

        // BR-303/Deviation #6: silently keeping the OLD selection set after
        // a type change would leave selections scoped to a checklist the
        // new type may not even expose. Force the caller to re-pick. Runs
        // after the FK check above, so a bogus type id is 404, and only a
        // valid-but-different type without checklistItemIds hits this 400.
        if (
          body.interventionTypeId !== undefined &&
          body.interventionTypeId !== existing.interventionTypeId &&
          body.checklistItemIds === undefined
        ) {
          throw businessError(
            'intervention.creation.checklist_required',
            400,
            'Cambiando il tipo di intervento devi riselezionare le voci checklist.',
          );
        }

        // Build the partial update payload. Override flags / reason /
        // checklistItemIds are never persisted here — only the 4 scalar
        // BR-065 editable fields land on the row (checklistItemIds is
        // handled separately below; it is not an intervention column).
        const data: Record<string, unknown> = {};
        for (const k of EDITABLE_KEYS) {
          const value = (body as Record<string, unknown>)[k];
          if (value !== undefined) {
            data[k] = value as unknown;
          }
        }

        if (data.partsReplaced !== undefined) {
          data.partsReplaced = data.partsReplaced as Prisma.InputJsonValue;
        }

        if (lockState.lockedAtToPersist !== null) {
          data.wikiLockedAt = lockState.lockedAtToPersist;
        }

        await tx.intervention.update({ where: { id }, data });

        // BR-303 — replace-set edit. Only runs when checklistItemIds is
        // present in the body; absent means "leave selections untouched"
        // (distinct from an empty array, which is BR-300's "at least one
        // item required" rejection inside validateChecklistSelection).
        if (body.checklistItemIds !== undefined) {
          const foundItems = await validateChecklistSelection(tx, {
            tenantId,
            interventionTypeId: effectiveTypeId,
            checklistItemIds: body.checklistItemIds,
          });

          const existingSelections = await tx.interventionChecklistSelection.findMany({
            where: { interventionId: id },
            select: { id: true, checklistItemId: true },
          });

          // `new Set(...)` on the raw body array already dedups repeated
          // ids — no separate dedup step needed.
          const desired = new Set(body.checklistItemIds);

          // Deviation #7: also sweep any orphaned selection whose
          // checklist_item_id has gone NULL (catalog item hard-deleted
          // elsewhere, onDelete: SetNull) — it can never be "desired"
          // again since its id no longer exists.
          const toDeleteIds = existingSelections
            .filter((s) => s.checklistItemId === null || !desired.has(s.checklistItemId))
            .map((s) => s.id);
          if (toDeleteIds.length > 0) {
            await tx.interventionChecklistSelection.deleteMany({
              where: { id: { in: toDeleteIds } },
            });
          }

          // Retained selections (present before and after) are left alone
          // here — their label_snapshot/sort_order_snapshot stay exactly
          // as originally written, which is the BR-303 guarantee under
          // test. Only genuinely new items get a snapshot, taken from the
          // catalog rows validateChecklistSelection just resolved.
          const existingItemIds = new Set(
            existingSelections.map((s) => s.checklistItemId).filter((v): v is string => v !== null),
          );
          const toAdd = foundItems.filter((it) => !existingItemIds.has(it.id));
          if (toAdd.length > 0) {
            await tx.interventionChecklistSelection.createMany({
              data: toAdd.map((it) => ({
                interventionId: id,
                tenantId,
                checklistItemId: it.id,
                labelSnapshot: it.nameIt,
                sortOrderSnapshot: it.sortOrder,
              })),
            });
          }
        }

        let revision: {
          id: string;
          revisedAt: Date;
          changes: Prisma.JsonValue;
          reason: string | null;
        } | null = null;
        if (lockState.isLocked) {
          const changes = buildChangesJson(
            existing as Record<string, unknown>,
            body as Record<string, unknown>,
          );
          revision = await tx.interventionRevision.create({
            data: {
              interventionId: id,
              userId: user.id,
              revisedAt: now,
              changes: changes as Prisma.InputJsonValue,
              reason: body.reason ?? null,
            },
            select: { id: true, revisedAt: true, changes: true, reason: true },
          });
        }

        // H1 / BR-064: resolve recipient and tenant for post-commit
        // notification. Only when wiki window is closed AND a revision row
        // was actually written. Pre-lock = wiki window, no notify.
        let recipient: CustomerForNotification | null = null;
        let tenantRow: { id: string; businessName: string } | null = null;
        if (lockState.isLocked && revision) {
          recipient = await resolveCurrentOwner(tx, existing.vehicleId);
          if (recipient) {
            tenantRow = await tx.tenant.findUniqueOrThrow({
              where: { id: tenantId },
              select: { id: true, businessName: true },
            });
          }
        }

        await recordVehicleAccess({
          tx,
          vehicleId: existing.vehicleId,
          tenantId,
          userId: user.id,
          action: 'update',
          ipAddress: request.ip,
          log: request.log,
        });

        const reloaded = await tx.intervention.findUniqueOrThrow({
          where: { id },
          select: {
            id: true,
            tenantId: true,
            userId: true,
            vehicleId: true,
            interventionTypeId: true,
            interventionDate: true,
            odometerKm: true,
            description: true,
            partsReplaced: true,
            internalNotes: true,
            status: true,
            kmAnomaly: true,
            firstSeenByCustomerAt: true,
            wikiLockedAt: true,
            createdAt: true,
            updatedAt: true,
            interventionType: {
              select: { id: true, code: true, nameIt: true },
            },
            checklistSelections: {
              select: { checklistItemId: true, labelSnapshot: true, sortOrderSnapshot: true },
              orderBy: [{ sortOrderSnapshot: 'asc' }, { labelSnapshot: 'asc' }],
            },
          },
        });

        // BR-303: build the wire-shape `checklistItems` from whatever is
        // actually persisted post-replace (retained + newly-added rows
        // alike) rather than re-deriving from `body` — the response
        // always reflects committed state, not the request payload.
        const { checklistSelections, ...reloadedRest } = reloaded;
        const intervention = {
          ...reloadedRest,
          checklistItems: serializeChecklistItems(checklistSelections),
        };

        return { intervention, revision, recipient, tenantRow };
      });

      // BR-064 dispatch runs AFTER the transaction commits. It is
      // best-effort: dispatchNotification never throws (see contract in
      // dispatcher.ts), so a SES failure here cannot roll back the
      // revision row or the intervention update. The guard skips dispatch
      // when there is no revision (pre-lock edit) or no resolvable
      // recipient (no active owner / deleted customer).
      if (result.revision && result.recipient && result.tenantRow) {
        await dispatchNotification({
          event: {
            type: 'intervention.revised',
            intervention: {
              id: result.intervention.id,
              vehicleId: result.intervention.vehicleId,
              // BR-308/Deviation #3: title no longer exists on the row or
              // in the response DTO (mirrors interventions.ts create route).
              title: null,
              description: result.intervention.description,
              cancelledReason: null,
            },
            revision: {
              id: result.revision.id,
              revisedAt: result.revision.revisedAt,
              reason: result.revision.reason,
              changes: result.revision.changes,
            },
            tenant: result.tenantRow,
          },
          recipient: result.recipient,
          logger: request.log,
          app,
        });
      }

      return { intervention: result.intervention, revision: result.revision };
    },
  );
};

export default interventionUpdateRoutes;
