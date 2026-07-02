import { z } from 'zod';
import { CATEGORY_VALUES } from '@/lib/catalog-types';

// Schemas mirror the POST/PATCH /v1/admin/intervention-types request bodies
// (packages/api/src/routes/v1/admin-intervention-types.ts CreateTypeBody /
// UpdateTypeBody). Italian validation messages match UX copy guidelines.

// Optional positive-int backed by a plain text input: empty string -> null
// (field cleared/unset), non-empty -> validated positive integer. Using a
// text input + custom transform (rather than type="number" + valueAsNumber)
// avoids the NaN-on-empty pitfall of the latter for a genuinely optional field.
function optionalPositiveInt(message: string) {
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

// Create form — includes code + category (both immutable after creation).
export const catalogTypeSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9_]{0,49}$/, 'Codice non valido: lettere maiuscole, cifre e underscore'),
  nameIt: z.string().trim().min(1, 'Nome obbligatorio').max(150, 'Nome troppo lungo'),
  description: optionalText(1000, 'Descrizione troppo lunga'),
  icon: optionalText(50, 'Icona troppo lunga'),
  category: z.enum(CATEGORY_VALUES),
  suggestsDeadline: z.boolean(),
  defaultDeadlineMonths: optionalPositiveInt('Mesi: intero positivo'),
  defaultDeadlineKm: optionalPositiveInt('Km: intero positivo'),
  active: z.boolean(),
});

export type CatalogTypeValues = z.input<typeof catalogTypeSchema>;
export type CatalogTypeParsed = z.output<typeof catalogTypeSchema>;

// Edit form — code and category are immutable after creation, so PATCH omits
// them entirely (mirrors UpdateTypeBody server-side).
export const editCatalogTypeSchema = z.object({
  nameIt: z.string().trim().min(1, 'Nome obbligatorio').max(150, 'Nome troppo lungo'),
  description: optionalText(1000, 'Descrizione troppo lunga'),
  icon: optionalText(50, 'Icona troppo lunga'),
  suggestsDeadline: z.boolean(),
  defaultDeadlineMonths: optionalPositiveInt('Mesi: intero positivo'),
  defaultDeadlineKm: optionalPositiveInt('Km: intero positivo'),
  active: z.boolean(),
});

export type EditCatalogTypeValues = z.input<typeof editCatalogTypeSchema>;
export type EditCatalogTypeParsed = z.output<typeof editCatalogTypeSchema>;
