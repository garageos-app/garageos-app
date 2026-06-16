import {
  CreatePersonalDeadlineSchema,
  Prisma,
  UpdatePersonalDeadlineSchema,
} from '@garageos/database';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { businessError } from '../../lib/business-error.js';
import {
  PERSONAL_DEADLINE_SELECT,
  serializePersonalDeadline,
} from '../../lib/dtos/personal-deadline.js';
import { buildPersonalReminders } from '../../lib/personal-deadlines/build-reminders.js';
import { clientiContext } from '../../middleware/clienti-context.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireClientiPool } from '../../middleware/require-clienti-pool.js';

// /v1/me/personal-deadlines* — customer-app surface for personal vehicle
// deadlines (F-CLI-306). A customer records reminders against a vehicle they
// own (insurance, road tax, inspection, …); the API materializes the lead/
// tail reminder rows that the H3 scheduler later delivers (BR-293/BR-295).
//
// Security: personal_deadlines and personal_deadline_reminders RLS is
// USING(true), so isolation is enforced ENTIRELY app-layer — every query
// filters customerId (the #154 lesson). Single-row lookups use
// findFirst({ where: { id, customerId } }) + manual 404 (RLS-as-404; never
// findUniqueOrThrow, which would leak existence cross-customer).
//
// All routes run under role:'user' since both tables are USING(true).

// PersonalDeadlineStatus enum values (schema.prisma) — declared locally for
// the GET ?status= filter; the Prisma enum is not exported as a runtime value.
const statusEnum = z.enum(['open', 'completed', 'overdue', 'cancelled']);

const idParamSchema = z.object({ id: z.uuid() });

const listQuerySchema = z
  .object({
    status: statusEnum.optional(),
    vehicleId: z.uuid().optional(),
  })
  .strict();

// Parse a YYYY-MM-DD string into a Date anchored at UTC midnight, matching the
// @db.Date column semantics (the validators guarantee the DATE_ONLY shape).
function toDateOnly(value: string): Date {
  return new Date(value + 'T00:00:00.000Z');
}

const mePersonalDeadlinesRoutes: FastifyPluginAsync = async (app) => {
  // POST /v1/me/personal-deadlines — create a deadline on an owned vehicle
  // and materialize its reminder rows. BR-290: only the active owner may add
  // a personal deadline to a vehicle.
  app.post(
    '/v1/me/personal-deadlines',
    { preHandler: [requireAuth, requireClientiPool, clientiContext] },
    async (request, reply) => {
      const parsed = CreatePersonalDeadlineSchema.parse(request.body);
      const customerId = request.customerId!;

      return app.withContext({ customerId, role: 'user' }, async (tx) => {
        // BR-290: ownership check — the caller must be the active owner.
        const vehicle = await tx.vehicle.findFirst({
          where: { id: parsed.vehicleId },
          select: {
            id: true,
            ownerships: { where: { endedAt: null }, select: { customerId: true } },
          },
        });
        if (!vehicle || vehicle.ownerships[0]?.customerId !== customerId) {
          throw businessError(
            'personal_deadline.vehicle_not_owned',
            403,
            'Non sei il proprietario di questo veicolo.',
          );
        }

        const dueDate = toDateOnly(parsed.dueDate);

        // Include each optional key only when present so a missing field is
        // not written. Record<string, unknown> sidesteps exactOptionalProperty
        // Types (assigning `undefined` to an optional Prisma key is rejected).
        const data: Record<string, unknown> = {
          customerId,
          vehicleId: parsed.vehicleId,
          category: parsed.category,
          dueDate,
          reminderLeadDays: parsed.reminderLeadDays,
          notifyPush: parsed.notifyPush,
          notifyEmail: parsed.notifyEmail,
        };
        if (parsed.customLabel !== undefined) data.customLabel = parsed.customLabel;
        if (parsed.recurrenceMonths !== undefined) data.recurrenceMonths = parsed.recurrenceMonths;
        if (parsed.reminderDailyTailDays !== undefined)
          data.reminderDailyTailDays = parsed.reminderDailyTailDays;
        if (parsed.notes !== undefined) data.notes = parsed.notes;

        const created = await tx.personalDeadline.create({
          data: data as Prisma.PersonalDeadlineUncheckedCreateInput,
          select: { id: true },
        });

        // Materialize the lead/tail reminder rows (BR-293/BR-295). createMany
        // in a single statement — never Promise.all over the tx.
        const rows = buildPersonalReminders(
          dueDate,
          parsed.reminderLeadDays,
          parsed.reminderDailyTailDays ?? null,
        );
        if (rows.length > 0) {
          await tx.personalDeadlineReminder.createMany({
            data: rows.map((r) => ({
              personalDeadlineId: created.id,
              scheduledFor: r.scheduledFor,
              kind: r.kind,
            })),
          });
        }

        const row = await tx.personalDeadline.findFirst({
          where: { id: created.id, customerId },
          select: PERSONAL_DEADLINE_SELECT,
        });
        reply.code(201);
        return serializePersonalDeadline(row!);
      });
    },
  );

  // GET /v1/me/personal-deadlines — list the caller's deadlines, optionally
  // filtered by status and/or vehicle. No pagination (a customer holds few).
  app.get(
    '/v1/me/personal-deadlines',
    { preHandler: [requireAuth, requireClientiPool, clientiContext] },
    async (request) => {
      const { status, vehicleId } = listQuerySchema.parse(request.query);
      const customerId = request.customerId!;

      return app.withContext({ customerId, role: 'user' }, async (tx) => {
        const where: Prisma.PersonalDeadlineWhereInput = {
          customerId,
          ...(status && { status }),
          ...(vehicleId && { vehicleId }),
        };
        const rows = await tx.personalDeadline.findMany({
          where,
          orderBy: [{ dueDate: 'asc' }],
          select: PERSONAL_DEADLINE_SELECT,
        });
        return { data: rows.map(serializePersonalDeadline) };
      });
    },
  );

  // GET /v1/me/personal-deadlines/:id — detail. App-layer customerId scoping;
  // out-of-perimeter id → 404 (does not reveal existence).
  app.get(
    '/v1/me/personal-deadlines/:id',
    { preHandler: [requireAuth, requireClientiPool, clientiContext] },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const customerId = request.customerId!;

      return app.withContext({ customerId, role: 'user' }, async (tx) => {
        const row = await tx.personalDeadline.findFirst({
          where: { id, customerId },
          select: PERSONAL_DEADLINE_SELECT,
        });
        if (!row) {
          throw businessError('personal_deadline.not_found', 404, 'Scadenza non trovata.');
        }
        return { personalDeadline: serializePersonalDeadline(row) };
      });
    },
  );

  // PATCH /v1/me/personal-deadlines/:id — partial update. When dueDate or any
  // reminder field changes, pending reminders are regenerated (BR-294 timing);
  // sent/failed/cancelled rows are left untouched (append-only).
  app.patch(
    '/v1/me/personal-deadlines/:id',
    { preHandler: [requireAuth, requireClientiPool, clientiContext] },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const parsed = UpdatePersonalDeadlineSchema.parse(request.body);
      const customerId = request.customerId!;

      if (Object.keys(parsed).length === 0) {
        throw businessError(
          'personal_deadline.update.empty_body',
          422,
          'Specifica almeno un campo da aggiornare.',
        );
      }

      return app.withContext({ customerId, role: 'user' }, async (tx) => {
        const row = await tx.personalDeadline.findFirst({
          where: { id, customerId },
          select: {
            id: true,
            category: true,
            customLabel: true,
            dueDate: true,
            reminderLeadDays: true,
            reminderDailyTailDays: true,
          },
        });
        if (!row) {
          throw businessError('personal_deadline.not_found', 404, 'Scadenza non trovata.');
        }

        // BR-294 cross-field: customLabel is required when the effective
        // category is 'other'. The category and/or label may be absent from
        // the body, so resolve both against the current row.
        const effectiveCategory = parsed.category ?? row.category;
        const effectiveLabel = 'customLabel' in parsed ? parsed.customLabel : row.customLabel;
        if (
          effectiveCategory === 'other' &&
          (effectiveLabel == null || effectiveLabel.length === 0)
        ) {
          throw businessError(
            'personal_deadline.custom_label_required',
            422,
            "Specifica un'etichetta per la categoria 'Altro'.",
          );
        }

        // Build the update payload: include each key only when present so a
        // missing field is not clobbered. Nullable keys accept `null` to clear
        // the column (preserved). Record<string, unknown> sidesteps
        // exactOptionalPropertyTypes. Convert dueDate string → Date.
        const data: Record<string, unknown> = {};
        if (parsed.category !== undefined) data.category = parsed.category;
        if (parsed.customLabel !== undefined) data.customLabel = parsed.customLabel;
        if (parsed.dueDate !== undefined) data.dueDate = toDateOnly(parsed.dueDate);
        if (parsed.recurrenceMonths !== undefined) data.recurrenceMonths = parsed.recurrenceMonths;
        if (parsed.reminderLeadDays !== undefined) data.reminderLeadDays = parsed.reminderLeadDays;
        if (parsed.reminderDailyTailDays !== undefined)
          data.reminderDailyTailDays = parsed.reminderDailyTailDays;
        if (parsed.notifyPush !== undefined) data.notifyPush = parsed.notifyPush;
        if (parsed.notifyEmail !== undefined) data.notifyEmail = parsed.notifyEmail;
        if (parsed.notes !== undefined) data.notes = parsed.notes;

        // Regenerate pending reminders when any timing input changes. Fields
        // not in the body fall back to the current row values.
        const remindersChanged =
          'dueDate' in parsed || 'reminderLeadDays' in parsed || 'reminderDailyTailDays' in parsed;
        if (remindersChanged) {
          const newDueDate =
            parsed.dueDate !== undefined ? toDateOnly(parsed.dueDate) : row.dueDate;
          const newLead =
            parsed.reminderLeadDays !== undefined ? parsed.reminderLeadDays : row.reminderLeadDays;
          const newTail =
            'reminderDailyTailDays' in parsed
              ? (parsed.reminderDailyTailDays ?? null)
              : row.reminderDailyTailDays;

          // Append-only: only pending rows are recomputed; already-sent (or
          // failed/cancelled) reminders are immutable history.
          await tx.personalDeadlineReminder.deleteMany({
            where: { personalDeadlineId: id, deliveryStatus: 'pending' },
          });
          const newRows = buildPersonalReminders(newDueDate, newLead, newTail);
          if (newRows.length > 0) {
            await tx.personalDeadlineReminder.createMany({
              data: newRows.map((r) => ({
                personalDeadlineId: id,
                scheduledFor: r.scheduledFor,
                kind: r.kind,
              })),
            });
          }
        }

        await tx.personalDeadline.update({ where: { id }, data });

        const updated = await tx.personalDeadline.findFirst({
          where: { id, customerId },
          select: PERSONAL_DEADLINE_SELECT,
        });
        return { personalDeadline: serializePersonalDeadline(updated!) };
      });
    },
  );

  // DELETE /v1/me/personal-deadlines/:id — hard delete. The DB cascade
  // removes the reminder rows.
  app.delete(
    '/v1/me/personal-deadlines/:id',
    { preHandler: [requireAuth, requireClientiPool, clientiContext] },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const customerId = request.customerId!;

      return app.withContext({ customerId, role: 'user' }, async (tx) => {
        const row = await tx.personalDeadline.findFirst({
          where: { id, customerId },
          select: { id: true },
        });
        if (!row) {
          throw businessError('personal_deadline.not_found', 404, 'Scadenza non trovata.');
        }
        await tx.personalDeadline.delete({ where: { id } });
        reply.code(204);
        return null;
      });
    },
  );

  // POST /v1/me/personal-deadlines/:id/complete — mark a deadline done.
  // BR-296: when the deadline recurs, return a renewalSuggestion the client
  // pre-fills into a create form (no auto-creation here).
  app.post(
    '/v1/me/personal-deadlines/:id/complete',
    { preHandler: [requireAuth, requireClientiPool, clientiContext] },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const customerId = request.customerId!;

      return app.withContext({ customerId, role: 'user' }, async (tx) => {
        const row = await tx.personalDeadline.findFirst({
          where: { id, customerId },
          select: {
            id: true,
            status: true,
            dueDate: true,
            recurrenceMonths: true,
            category: true,
            customLabel: true,
            reminderLeadDays: true,
            reminderDailyTailDays: true,
            notifyPush: true,
            notifyEmail: true,
          },
        });
        if (!row) {
          throw businessError('personal_deadline.not_found', 404, 'Scadenza non trovata.');
        }
        if (row.status !== 'open') {
          throw businessError(
            'personal_deadline.not_open',
            409,
            'La scadenza non è in stato aperto.',
          );
        }

        await tx.personalDeadline.update({
          where: { id },
          data: { status: 'completed', completedAt: new Date() },
        });
        // Pending reminders are no longer relevant once completed.
        await tx.personalDeadlineReminder.deleteMany({
          where: { personalDeadlineId: id, deliveryStatus: 'pending' },
        });

        const updated = await tx.personalDeadline.findFirst({
          where: { id, customerId },
          select: PERSONAL_DEADLINE_SELECT,
        });

        // BR-296: build the renewal suggestion for recurring deadlines.
        let renewalSuggestion:
          | {
              suggestedDueDate: string;
              category: string;
              customLabel?: string;
              recurrenceMonths: number;
              reminderLeadDays: number[];
              reminderDailyTailDays?: number;
              notifyPush: boolean;
              notifyEmail: boolean;
            }
          | undefined;

        if (row.recurrenceMonths != null) {
          renewalSuggestion = {
            suggestedDueDate: addMonthsUtc(row.dueDate, row.recurrenceMonths),
            category: row.category,
            recurrenceMonths: row.recurrenceMonths,
            reminderLeadDays: row.reminderLeadDays,
            notifyPush: row.notifyPush,
            notifyEmail: row.notifyEmail,
            ...(row.customLabel != null && { customLabel: row.customLabel }),
            ...(row.reminderDailyTailDays != null && {
              reminderDailyTailDays: row.reminderDailyTailDays,
            }),
          };
        }

        return {
          personalDeadline: serializePersonalDeadline(updated!),
          ...(renewalSuggestion && { renewalSuggestion }),
        };
      });
    },
  );
};

// Add `months` to a @db.Date value using UTC calendar arithmetic and return a
// bare YYYY-MM-DD string. Day overflow rolls forward (e.g. Jan 31 + 1 month →
// Mar 3) — acceptable since BR-296 only pre-fills a form the user confirms.
function addMonthsUtc(date: Date, months: number): string {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const d = date.getUTCDate();
  const result = new Date(Date.UTC(y, m + months, d));
  return result.toISOString().slice(0, 10);
}

export default mePersonalDeadlinesRoutes;
