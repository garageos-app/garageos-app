import { z } from 'zod';

// BR-071 — parts_replaced item shape. Mirrors PartReplacedSchema from
// @garageos/database (intervention.ts:8-13). Defined locally because
// @garageos/database is not a dependency of @garageos/web — the same
// approach used by intervention.ts (create form).
const PartReplacedSchema = z.object({
  name: z.string().min(1).max(200),
  code: z.string().max(50).optional(),
  quantity: z.number().positive(),
  notes: z.string().max(200).optional(),
});

// Mirrors @garageos/database UpdateInterventionSchema for the 5 BR-065
// editable fields, with two intentional divergences:
//
//   - `reason` is NOT min(10) here even though the backend Zod is. The
//     web dialog allows the user to type a partial reason while editing;
//     the "min 10 when locked" gate lives in the dialog handler so we can
//     surface inline error copy ("almeno 10 caratteri") under the field
//     instead of a generic Zod validation message. The dialog strips
//     reason from the PATCH body if the trimmed length is < 10, so the
//     backend Zod constraint is never reached for "too short" values.
//
//   - No "at least one field changed" refine — that constraint depends
//     on `defaultValues` context which Zod has no access to. The dialog
//     handles it via a diff helper before calling the mutation.
//
// The two fields nullable+optional (title, internalNotes) mirror the
// backend: `null` clears the field, `undefined` leaves it unchanged.
export const EditInterventionFormSchema = z.object({
  interventionTypeId: z.string().uuid().optional(),
  title: z.string().max(200).nullable().optional(),
  description: z.string().min(1).max(5000).optional(),
  partsReplaced: z.array(PartReplacedSchema).optional(),
  internalNotes: z.string().max(5000).nullable().optional(),
  reason: z.string().max(2000).optional(),
});

export type EditInterventionFormValues = z.infer<typeof EditInterventionFormSchema>;

// Body shape sent to PATCH /v1/interventions/:id. Identical to
// EditInterventionFormValues; aliased for clarity at the call site.
export type EditInterventionPayload = EditInterventionFormValues;
