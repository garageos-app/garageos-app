import { z } from 'zod';

// Schemas mirror the POST/PATCH /v1/admin/intervention-types request bodies
// (packages/api/src/routes/v1/admin-intervention-types.ts CreateTypeBody /
// UpdateTypeBody). Italian validation messages match UX copy guidelines.

// Optional positive-int backed by a plain text input: empty string -> null
// (field cleared/unset), non-empty -> validated positive integer. Using a
// text input + custom transform (rather than type="number" + valueAsNumber)
// avoids the NaN-on-empty pitfall of the latter for a genuinely optional field.
// `max`/`maxMessage` mirror the API's caps (CreateTypeBody/UpdateTypeBody
// .max(600) / .max(2_000_000)) — checked inside the transform since `.max()`
// cannot chain after `.transform()`.
function optionalPositiveInt(message: string, max: number, maxMessage: string) {
  return z
    .string()
    .trim()
    .transform((s, ctx) => {
      if (s === '') return null;
      const n = Number(s);
      if (!Number.isInteger(n) || n <= 0) {
        ctx.addIssue({ code: 'custom', message });
        return z.NEVER;
      }
      if (n > max) {
        ctx.addIssue({ code: 'custom', message: maxMessage });
        return z.NEVER;
      }
      return n;
    });
}

// Optional text field: empty string -> undefined so JSON.stringify omits the
// key entirely, matching the API's `.optional()` (no `.nullable()`) contract.
function optionalText(maxLength: number, message: string) {
  return z
    .string()
    .trim()
    .max(maxLength, message)
    .transform((s) => (s === '' ? undefined : s));
}

// Nullable text field for the edit form: empty string -> null so the PATCH
// body carries the key with an explicit null, which the API now accepts
// (UpdateTypeBody.description/icon are .nullable()) to clear a previously
// set value. Omitting the key (undefined) instead would silently no-op —
// see the PR-2 review fix for description/icon clearing.
function nullableText(maxLength: number, message: string) {
  return z
    .string()
    .trim()
    .max(maxLength, message)
    .transform((s) => (s === '' ? null : s));
}

// Create form — includes code (immutable after creation).
export const catalogTypeSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9_]{0,49}$/, 'Codice non valido: lettere maiuscole, cifre e underscore'),
  nameIt: z.string().trim().min(1, 'Nome obbligatorio').max(150, 'Nome troppo lungo'),
  description: optionalText(1000, 'Descrizione troppo lunga'),
  icon: optionalText(50, 'Icona troppo lunga'),
  suggestsDeadline: z.boolean(),
  defaultDeadlineMonths: optionalPositiveInt('Mesi: intero positivo', 600, 'Massimo 600 mesi'),
  defaultDeadlineKm: optionalPositiveInt('Km: intero positivo', 2_000_000, 'Massimo 2.000.000 km'),
  active: z.boolean(),
});

export type CatalogTypeValues = z.input<typeof catalogTypeSchema>;
export type CatalogTypeParsed = z.output<typeof catalogTypeSchema>;

// Edit form — code is immutable after creation, so PATCH omits it entirely
// (mirrors UpdateTypeBody server-side).
export const editCatalogTypeSchema = z.object({
  nameIt: z.string().trim().min(1, 'Nome obbligatorio').max(150, 'Nome troppo lungo'),
  description: nullableText(1000, 'Descrizione troppo lunga'),
  icon: nullableText(50, 'Icona troppo lunga'),
  suggestsDeadline: z.boolean(),
  defaultDeadlineMonths: optionalPositiveInt('Mesi: intero positivo', 600, 'Massimo 600 mesi'),
  defaultDeadlineKm: optionalPositiveInt('Km: intero positivo', 2_000_000, 'Massimo 2.000.000 km'),
  active: z.boolean(),
});

export type EditCatalogTypeValues = z.input<typeof editCatalogTypeSchema>;
export type EditCatalogTypeParsed = z.output<typeof editCatalogTypeSchema>;
