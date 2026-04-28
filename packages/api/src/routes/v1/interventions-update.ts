import { Prisma, UpdateInterventionSchema } from '@garageos/database';
import type { FastifyPluginAsync } from 'fastify';

import { recordVehicleAccess } from '../../lib/access-log.js';
import { businessError } from '../../lib/business-error.js';
import { idParamSchema } from '../../lib/vehicle-shared.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

// PATCH /v1/interventions/:id (F-OFF-304). RLS interventions_write
// enforces tenant ownership; cross-tenant write falls out as P2025 →
// 404 via the shared error handler (RLS-as-404). BR-062 wiki-window
// vs post-lock behavior is computed from
// (now - createdAt, firstSeenByCustomerAt, wikiLockedAt).
// BR-064 — post-lock revision row + reason; BR-065 — 5 editable
// fields; BR-128/BR-130 — disputed/cancelled blocked.

const EDITABLE_KEYS = [
  'interventionTypeId',
  'title',
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
  const ageGate = ageMs >= 48 * 60 * 60 * 1000;
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
  const fields = ['interventionTypeId', 'title', 'description', 'partsReplaced', 'internalNotes'];
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

      return app.withContext({ tenantId }, async (tx) => {
        // (cognitoSub, tenantId) lookup post-0004 — see users.ts header.
        const user = await tx.user.findFirstOrThrow({
          where: { cognitoSub, tenantId },
          select: { id: true, locationId: true },
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
            title: true,
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

        // FK validation on type change. Cross-tenant + system NULL types
        // are visible via RLS; an unknown id surfaces as P2025 → 404
        // NOT_FOUND via the global handler. Mirrors POST /interventions.
        if (
          body.interventionTypeId !== undefined &&
          body.interventionTypeId !== existing.interventionTypeId
        ) {
          await tx.interventionType.findUniqueOrThrow({
            where: { id: body.interventionTypeId },
            select: { id: true },
          });
        }

        // Build the partial update payload. Override flags / reason are
        // never persisted — only the 5 BR-065 editable fields land on
        // the row.
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

        // TODO post-lock: notifica push + email cliente sulla revision
        // (BR-064). Push tokens infra + SES non shipped — placeholder.

        await recordVehicleAccess({
          tx,
          vehicleId: existing.vehicleId,
          tenantId,
          userId: user.id,
          ...(user.locationId ? { locationId: user.locationId } : {}),
          action: 'update',
          ipAddress: request.ip,
          log: request.log,
        });

        const reloaded = await tx.intervention.findUniqueOrThrow({
          where: { id },
          select: {
            id: true,
            tenantId: true,
            locationId: true,
            userId: true,
            vehicleId: true,
            interventionTypeId: true,
            interventionDate: true,
            odometerKm: true,
            title: true,
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
          },
        });

        return { intervention: reloaded, revision };
      });
    },
  );
};

export default interventionUpdateRoutes;
