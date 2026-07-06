import { CreateInterventionSchema, Prisma } from '@garageos/database';
import type { FastifyError, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { recordVehicleAccess } from '../../lib/access-log.js';
import {
  serializeChecklistItems,
  todayUtcMidnight,
  validateChecklistSelection,
} from '../../lib/intervention-shared.js';
import { dispatchNotification } from '../../lib/notifications/dispatcher.js';
import { resolveCurrentOwner } from '../../lib/notifications/recipient-resolver.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

const idParamSchema = z.object({
  id: z.uuid(),
});

// Reuses CreateInterventionSchema verbatim from @garageos/database
// (interventionTypeId, interventionDate YYYY-MM-DD, odometerKm,
// checklistItemIds, description, partsReplaced, internalNotes,
// createDeadline, forceKmDecrease). BR-308: `title` no longer exists on
// this schema (or on the Intervention row's write path) — the checklist
// selection is now the structured replacement. No API-only extension is
// required: forceKmDecrease already lives in the shared schema because
// BR-068 is a service-layer rule.
const CreateInterventionBodySchema = CreateInterventionSchema;

// Problem+JSON factory mirroring vehicles.ts. The shared error handler
// (plugins/error-handler.ts:144-155) detects dot-separated names by regex
// and emits them as `code` unchanged.
function businessError(code: string, status: number, detail: string): FastifyError {
  const err = new Error(detail) as FastifyError;
  err.name = code;
  err.statusCode = status;
  return err;
}

// BR-083: previous max km is computed ONLY across officina interventions.
// Customer-side `private_interventions` are self-declared and less
// reliable, so they do NOT concur to the BR-068 (km non-decreasing)
// check. Conversely — APPENDICE_F:416 — a private intervention may carry
// any km without warning. Cancelled officina rows are excluded — they
// do not bind future km.
async function previousMaxOdometerKm(
  tx: import('@garageos/database').PrismaClient,
  vehicleId: string,
): Promise<number | null> {
  const officina = await tx.intervention.aggregate({
    where: { vehicleId, status: { not: 'cancelled' } },
    _max: { odometerKm: true },
  });
  return officina._max.odometerKm;
}

// Adds N calendar months to a base date in UTC. Used to project the
// deadline `due_date` from the intervention date — preserves the
// day-of-month and clamps to the last day of the target month when the
// source day does not exist (Jan 31 + 1 month → Feb 28/29).
function addMonthsUtc(base: Date, months: number): Date {
  const day = base.getUTCDate();
  const targetMonth = base.getUTCMonth() + months;
  const projected = new Date(Date.UTC(base.getUTCFullYear(), targetMonth, day, 0, 0, 0));
  // Day overflow check: if Date pushed into the next month (e.g. Feb 30 →
  // Mar 2), clamp back to the last day of the intended month.
  if (projected.getUTCMonth() !== ((targetMonth % 12) + 12) % 12) {
    return new Date(Date.UTC(base.getUTCFullYear(), targetMonth + 1, 0, 0, 0, 0));
  }
  return projected;
}

const interventionRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/v1/vehicles/:id/interventions',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request, reply) => {
      const { id: vehicleId } = idParamSchema.parse(request.params);
      const body = CreateInterventionBodySchema.parse(request.body);

      const tenantId = request.tenantId!;
      const cognitoSub = request.userId!;

      const result = await app.withContext({ tenantId }, async (tx) => {
        // User lookup mirrors vehicles.ts: JWT sub → DB user row. The
        // intervention.user_id FK points at users.id (UUID), not the
        // Cognito sub, so the round-trip is mandatory. Bound to
        // (cognitoSub, tenantId) post-0004 because `users_read` is
        // permissive — see users.ts header for rationale.
        const user = await tx.user.findFirstOrThrow({
          where: { cognitoSub, tenantId },
          select: { id: true },
        });

        // P2025 → 404 by the shared error handler. findUniqueOrThrow keeps
        // the error semantics identical to GET /v1/vehicles/:id.
        const vehicle = await tx.vehicle.findUniqueOrThrow({
          where: { id: vehicleId },
          select: {
            id: true,
            registrationDate: true,
            status: true,
            // plate/make/model feed the BR-157 notification payload.
            plate: true,
            make: true,
            model: true,
            ownerships: {
              where: { endedAt: null },
              select: { id: true, customerId: true },
              take: 1,
            },
          },
        });

        // BR-061 contract: archived vehicles cannot accept new interventions.
        // Cited explicitly in APPENDICE_G as `vehicle.modification.archived`.
        if (vehicle.status === 'archived') {
          throw businessError(
            'vehicle.modification.archived',
            422,
            'Il veicolo è archiviato e non accetta nuovi interventi.',
          );
        }

        // BR-070: intervention_date must be on/after vehicle.registration_date
        // when the latter is known. Historic vehicles (registration_date NULL)
        // are exempt — accept any past date.
        const interventionDateUtc = new Date(`${body.interventionDate}T00:00:00.000Z`);
        if (
          vehicle.registrationDate &&
          interventionDateUtc.getTime() < vehicle.registrationDate.getTime()
        ) {
          throw businessError(
            'intervention.creation.date_before_registration',
            400,
            "La data dell'intervento è precedente alla data di immatricolazione del veicolo.",
          );
        }

        // BR-069: future-dated interventions are not allowed. Comparison
        // is at UTC midnight to match the parsed intervention date anchor.
        if (interventionDateUtc.getTime() > todayUtcMidnight().getTime()) {
          throw businessError(
            'intervention.creation.date_future',
            400,
            'Non è possibile registrare interventi futuri.',
          );
        }

        // FK check on intervention type. Both system-wide (tenant_id NULL)
        // and tenant-custom rows are visible thanks to RLS. P2025 → 404 if
        // the id is bogus or the type belongs to another tenant.
        const interventionType = await tx.interventionType.findUniqueOrThrow({
          where: { id: body.interventionTypeId },
          select: {
            id: true,
            code: true,
            nameIt: true,
            suggestsDeadline: true,
            defaultDeadlineMonths: true,
            defaultDeadlineKm: true,
          },
        });

        // BR-300: at least one checklist item is required; BR-301 each id
        // must belong to `interventionType`; BR-302 each id must be active
        // and not excluded for this tenant. `foundItems` carries the DB
        // snapshot (nameIt/sortOrder) used below both for the frozen
        // label_snapshot (BR-303) and for the response DTO.
        const foundItems = await validateChecklistSelection(tx, {
          tenantId,
          interventionTypeId: body.interventionTypeId,
          checklistItemIds: body.checklistItemIds,
        });

        // BR-068: km must not decrease vs. previous officina interventions on this
        // vehicle (BR-083 excludes customer-side records). A decrease is a
        // *warning*, not a hard failure: the workshop can confirm with
        // `forceKmDecrease=true`, and the resulting row is flagged `kmAnomaly=true`
        // so downstream analytics can surface the override.
        const prevMaxKm = await previousMaxOdometerKm(tx, vehicleId);
        let kmAnomaly = false;
        if (prevMaxKm !== null && body.odometerKm < prevMaxKm) {
          if (!body.forceKmDecrease) {
            throw businessError(
              'intervention.creation.odometer_decrease_warning',
              409,
              `Km (${body.odometerKm}) inferiori al massimo storico (${prevMaxKm}). Passa forceKmDecrease=true per confermare.`,
            );
          }
          kmAnomaly = true;
        }

        const intervention = await tx.intervention.create({
          data: {
            tenantId,
            userId: user.id,
            vehicleId,
            interventionTypeId: interventionType.id,
            interventionDate: interventionDateUtc,
            odometerKm: body.odometerKm,
            description: body.description,
            partsReplaced: body.partsReplaced as Prisma.InputJsonValue,
            ...(body.internalNotes ? { internalNotes: body.internalNotes } : {}),
            kmAnomaly,
          },
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
            wikiLockedAt: true,
            createdAt: true,
          },
        });

        // BR-303: label_snapshot/sort_order_snapshot freeze the catalog
        // text at save time — later renames or reordering of the catalog
        // item must NOT retroactively change what this intervention shows.
        // tenantId is set explicitly (RLS `selections_insert` requires
        // tenant_id = current_tenant_id()); checklistItemId keeps the FK
        // for as long as the item exists (SetNull on delete).
        await tx.interventionChecklistSelection.createMany({
          data: foundItems.map((it) => ({
            interventionId: intervention.id,
            tenantId,
            checklistItemId: it.id,
            labelSnapshot: it.nameIt,
            sortOrderSnapshot: it.sortOrder,
          })),
        });

        // BR-152: ensure customer_tenant_relation exists for (tenant, current
        // owner). Skipped when the vehicle has no active ownership — rare
        // (transfers in flight, archived owner) but valid: there is no
        // customer to anchor the relation to.
        const currentOwner = vehicle.ownerships[0] ?? null;
        if (currentOwner) {
          await tx.customerTenantRelation.upsert({
            where: {
              tenantId_customerId: { tenantId, customerId: currentOwner.customerId },
            },
            update: {},
            create: {
              tenantId,
              customerId: currentOwner.customerId,
              interventionCount: 0,
            },
            select: { id: true },
          });
        }

        // BR-080: deadline auto-create is opt-in via request and uses the
        // intervention type's defaults unless the caller overrides them.
        // We compute due_date / due_odometer_km only when a corresponding
        // value is available — a deadline with both null would be created
        // as a no-op (notifications would never fire), so we skip it.
        let deadlineResponse: {
          id: string;
          dueDate: Date | null;
          dueOdometerKm: number | null;
          interventionTypeId: string;
          status: string;
        } | null = null;

        if (body.createDeadline?.enabled) {
          const months =
            body.createDeadline.monthsFromNow ?? interventionType.defaultDeadlineMonths;
          const km = body.createDeadline.kmIncrement ?? interventionType.defaultDeadlineKm;
          const dueDate = months ? addMonthsUtc(interventionDateUtc, months) : null;
          const dueOdometerKm = km ? body.odometerKm + km : null;

          if (dueDate || dueOdometerKm) {
            const deadline = await tx.deadline.create({
              data: {
                tenantId,
                vehicleId,
                interventionTypeId: interventionType.id,
                sourceInterventionId: intervention.id,
                ...(dueDate ? { dueDate } : {}),
                ...(dueOdometerKm !== null ? { dueOdometerKm } : {}),
              },
              select: {
                id: true,
                dueDate: true,
                dueOdometerKm: true,
                interventionTypeId: true,
                status: true,
              },
            });
            deadlineResponse = deadline;
          }
        }

        // BR-154: action='create' on the intervention's vehicle. Reuses the
        // shared helper so dedup rules stay centralized — creates are unique
        // by definition, but routing through the same path keeps the audit
        // trail uniform with view/search_match.
        await recordVehicleAccess({
          tx,
          vehicleId,
          tenantId,
          userId: user.id,
          action: 'create',
          ipAddress: request.ip,
          log: request.log,
        });

        // BR-157: resolve the notification recipient inside the tx so the
        // post-commit dispatch has a consistent snapshot. resolveCurrentOwner
        // applies BR-040 (single active owner) and the BR-158 deleted/
        // anonymized-customer skips. The tenant row is only fetched when a
        // recipient exists — no useless query on owner-less vehicles.
        const recipient = await resolveCurrentOwner(tx, vehicleId);
        const tenantRow = recipient
          ? await tx.tenant.findUniqueOrThrow({
              where: { id: tenantId },
              select: { id: true, businessName: true },
            })
          : null;

        return {
          response: {
            intervention: {
              ...intervention,
              interventionType: {
                id: interventionType.id,
                code: interventionType.code,
                nameIt: interventionType.nameIt,
              },
              checklistItems: serializeChecklistItems(
                foundItems.map((it) => ({
                  checklistItemId: it.id,
                  labelSnapshot: it.nameIt,
                  sortOrderSnapshot: it.sortOrder,
                })),
              ),
            },
            deadline: deadlineResponse,
          },
          recipient,
          tenantRow,
          vehicleForEmail: {
            id: vehicle.id,
            plate: vehicle.plate,
            make: vehicle.make,
            model: vehicle.model,
          },
        };
      });

      // BR-157 dispatch runs AFTER the transaction commits, mirroring the
      // BR-064 pattern in interventions-update.ts. It is best-effort:
      // dispatchNotification never throws (contract in dispatcher.ts), so a
      // transport failure cannot roll back the intervention row or turn the
      // 201 into an error. Gated by the intervention_updates preference
      // toggle (BR-226 v1.3) inside the dispatcher.
      if (result.recipient && result.tenantRow) {
        const created = result.response.intervention;
        await dispatchNotification({
          event: {
            type: 'intervention.created',
            intervention: {
              id: created.id,
              vehicleId: created.vehicleId,
              description: created.description,
              cancelledReason: null,
            },
            interventionTypeName: created.interventionType.nameIt,
            vehicle: result.vehicleForEmail,
            tenant: result.tenantRow,
          },
          recipient: result.recipient,
          logger: request.log,
          app,
        });
      }

      reply.code(201);
      return result.response;
    },
  );
};

export default interventionRoutes;
