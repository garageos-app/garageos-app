import { z } from 'zod';

// Source: docs/APPENDICE_B_DATABASE.md §5.3 — translated to Zod 4 syntax.
// Dispute schema lives here because BR-120..BR-130 treat disputes as an
// intervention child; splitting would only duplicate a single literal enum.

// BR-071 — parts_replaced is a JSON array of objects with the fields below.
export const PartReplacedSchema = z.object({
  name: z.string().min(1).max(200),
  code: z.string().max(50).optional(),
  quantity: z.number().positive(),
  notes: z.string().max(200).optional(),
});

export const CreateInterventionSchema = z.object({
  interventionTypeId: z.uuid(),
  interventionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  odometerKm: z.number().int().min(0),
  title: z.string().max(200).optional(),
  description: z.string().min(1).max(5000),
  partsReplaced: z.array(PartReplacedSchema).default([]),
  internalNotes: z.string().max(5000).optional(),
  createDeadline: z
    .object({
      enabled: z.boolean(),
      monthsFromNow: z.number().int().positive().optional(),
      kmIncrement: z.number().int().positive().optional(),
    })
    .optional(),
  // BR-068 — opt-in override when odometer decreases vs. prior intervention.
  // The rule itself (lookup + comparison) is service-layer; this flag just
  // records the operator's explicit confirmation.
  forceKmDecrease: z.boolean().default(false),
});

// BR-123 — dispute reason categories (fixed set, no `overcharge` in v1).
// BR-124 — description is 20..2000 chars.
export const CreateDisputeSchema = z.object({
  reasonCategory: z.enum(['not_performed', 'wrong_data', 'not_authorized', 'other']),
  description: z.string().min(20).max(2000),
  attachmentIds: z.array(z.uuid()).max(10).optional(),
});

// BR-065 — fields editable on PATCH /interventions/:id.
// BR-061 — vehicleId, interventionDate, odometerKm, tenantId, locationId,
//          userId are absent here on purpose; .strict() rejects them.
// BR-064 — reason is request-level metadata for the revision row created
//          when the wiki window is closed; required iff isLocked, validated
//          handler-side (not in Zod, depends on runtime state).
export const UpdateInterventionSchema = z
  .object({
    interventionTypeId: z.uuid().optional(),
    title: z.string().max(200).nullable().optional(),
    description: z.string().min(1).max(5000).optional(),
    partsReplaced: z.array(PartReplacedSchema).optional(),
    internalNotes: z.string().max(5000).nullable().optional(),
    reason: z.string().min(10).max(2000).optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.interventionTypeId !== undefined ||
      v.title !== undefined ||
      v.description !== undefined ||
      v.partsReplaced !== undefined ||
      v.internalNotes !== undefined,
    { message: 'Almeno un campo modificabile deve essere presente', path: [] },
  );

// BR-066 — minimal cancel payload. The `min(20)` reason bound is
// validated handler-side to expose the dedicated business code
// `intervention.cancellation.reason_too_short` rather than a generic
// `validation.error`. The `max(2000)` upper bound stays in Zod as a
// safety limit for arbitrarily long client input.
export const CancelInterventionSchema = z
  .object({
    reason: z.string().max(2000),
  })
  .strict();

// BR-129 — tenant_response is 20..2000 chars. The min(20) bound is
// validated handler-side to expose
// `intervention.dispute.response.description_too_short` instead of a
// generic `validation.error`. The max(2000) upper bound stays in Zod.
// `disputeId` is optional: when present, target a single dispute by id;
// when absent, target all `open` disputes on the parent intervention.
// `attachmentIds` accepted for forward-compat (rejected handler-side
// 422 in v1 — storage layer not shipped).
export const RespondToDisputeSchema = z
  .object({
    tenantResponse: z.string().max(2000),
    disputeId: z.uuid().optional(),
    attachmentIds: z.array(z.uuid()).max(10).optional(),
  })
  .strict();

// BR-100..BR-109 — POST /v1/vehicles/:vehicleId/deadlines payload (F-OFF-401).
// dueDate is coerced from ISO string to Date so the handler can hand it
// straight to Prisma + the Scheduler computation. The "today or future"
// guard is enforced in the schema (Zod refine) because BR-103 reminders
// are forward-looking — retroactive logging belongs in POST /interventions.
//
// isRecurring → recurringMonths/recurringKm cross-field constraint:
// at least one of the two cadence fields must be present when isRecurring=true.
// recurringKm-only is accepted at this layer for forward-compat (km-driven
// reminders are not yet wired in scheduling.ts but the row persists for
// future infrastructure — see compute-reminders.ts comment on `km_reached`).
export const CreateDeadlineSchema = z
  .object({
    interventionTypeId: z.uuid(),
    dueDate: z.coerce.date().refine(
      (d) => {
        const today = new Date();
        today.setUTCHours(0, 0, 0, 0);
        return d.getTime() >= today.getTime();
      },
      { message: 'dueDate must be today or in the future' },
    ),
    dueOdometerKm: z.number().int().min(0).max(10_000_000).nullish(),
    description: z.string().max(500).nullish(),
    isRecurring: z.boolean().default(false),
    recurringMonths: z.number().int().min(1).max(120).nullish(),
    recurringKm: z.number().int().min(1).max(10_000_000).nullish(),
    sourceInterventionId: z.uuid().nullish(),
  })
  .refine(
    (v) =>
      !v.isRecurring ||
      (v.recurringMonths != null && v.recurringMonths > 0) ||
      (v.recurringKm != null && v.recurringKm > 0),
    {
      message: 'isRecurring requires at least one of recurringMonths or recurringKm',
      path: ['recurringMonths'],
    },
  );

// BR-100..BR-109 — PATCH /v1/deadlines/:id payload (F-OFF-401).
// Partial-update semantics: every field is optional, but the request body
// must contain at least one field (a refine guard surfaces an empty body
// as a 400 VALIDATION_ERROR via the shared error-handler).
//
// dueDate carries the same forward-only guard as CreateDeadlineSchema
// (BR-103: reminders are forward-looking; rescheduling to the past is a
// non-sensical operation — to reschedule into the past, cancel + create
// a new historical record via POST /interventions).
//
// isRecurring → recurringMonths/recurringKm cross-field guard is NOT
// re-applied here. PATCH consumers may send `isRecurring: true` alone
// and update cadence in a follow-up call; the integrity check belongs
// at create time. If the row was created with a valid cadence, the
// update path may set `isRecurring=false` on its own without forcing the
// cadence fields back to null.
export const UpdateDeadlineSchema = z
  .object({
    dueDate: z.coerce
      .date()
      .refine(
        (d) => {
          const today = new Date();
          today.setUTCHours(0, 0, 0, 0);
          return d.getTime() >= today.getTime();
        },
        { message: 'dueDate must be today or in the future' },
      )
      .optional(),
    dueOdometerKm: z.number().int().min(0).max(10_000_000).nullable().optional(),
    description: z.string().max(500).nullable().optional(),
    isRecurring: z.boolean().optional(),
    recurringMonths: z.number().int().min(1).max(120).nullable().optional(),
    recurringKm: z.number().int().min(1).max(10_000_000).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'request body cannot be empty',
  });

// BR-100..BR-109 — POST /v1/deadlines/:id/complete payload (F-OFF-405).
// Single optional field: completedByInterventionId chains the intervention
// that closed the deadline. Cross-vehicle / cross-tenant validation is
// handler-side (422 deadline.complete.intervention_invalid).
export const CompleteDeadlineSchema = z.object({
  completedByInterventionId: z.uuid().nullish(),
});

export type PartReplaced = z.infer<typeof PartReplacedSchema>;
export type CreateInterventionInput = z.infer<typeof CreateInterventionSchema>;
export type CreateDisputeInput = z.infer<typeof CreateDisputeSchema>;
export type UpdateInterventionInput = z.infer<typeof UpdateInterventionSchema>;
export type CancelInterventionInput = z.infer<typeof CancelInterventionSchema>;
export type RespondToDisputeInput = z.infer<typeof RespondToDisputeSchema>;
export type CreateDeadlineInput = z.infer<typeof CreateDeadlineSchema>;
export type UpdateDeadlineInput = z.infer<typeof UpdateDeadlineSchema>;
export type CompleteDeadlineInput = z.infer<typeof CompleteDeadlineSchema>;
