import { z } from 'zod';

// BR-071 — parts_replaced item shape. Re-exported from the web-local
// BasePartReplacedSchema (see lib/validators/parts-replaced.ts) which mirrors
// the backend authoritative schema in @garageos/database. Edit form uses the
// base schema unchanged — quantity is decimal-permissive (positive, not
// integer-only), matching backend behavior (e.g. 0.5L oil quantities).
import { BasePartReplacedSchema as PartReplacedSchema } from './parts-replaced';
export { PartReplacedSchema };

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
// The nullable+optional field (internalNotes) mirrors the backend: `null`
// clears the field, `undefined` leaves it unchanged.
//
// checklistItemIds (BR-303/BR-308) diverges from that pattern: `undefined`
// leaves the checklist unchanged, an array replaces the whole selection
// set, but `null` is NOT accepted — BR-300 forbids an empty checklist, so
// there is no "clear" semantics to mirror here.
export const EditInterventionFormSchema = z.object({
  interventionTypeId: z.uuid().optional(),
  description: z.string().max(5000).optional(),
  partsReplaced: z.array(PartReplacedSchema).optional(),
  internalNotes: z.string().max(5000).nullable().optional(),
  reason: z.string().max(2000).optional(),
  checklistItemIds: z.array(z.uuid()).optional(),
});

export type EditInterventionFormValues = z.infer<typeof EditInterventionFormSchema>;

// Body shape sent to PATCH /v1/interventions/:id. Identical to
// EditInterventionFormValues; aliased for clarity at the call site.
export type EditInterventionPayload = EditInterventionFormValues;
