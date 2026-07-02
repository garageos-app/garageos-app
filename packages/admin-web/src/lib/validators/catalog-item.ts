import { z } from 'zod';

// Schemas mirror the POST /v1/admin/intervention-types/:id/checklist-items and
// PATCH /v1/admin/checklist-items/:itemId request bodies
// (packages/api/src/routes/v1/admin-checklist-items.ts CreateItemBody /
// UpdateItemBody). Italian validation messages match UX copy guidelines.

// Required non-negative-int backed by a plain text input: mirrors the
// optionalPositiveInt pattern in catalog-type.ts (text input + custom
// transform, avoiding the NaN-on-empty pitfall of type="number" +
// valueAsNumber), but this field is always required (server default is 0,
// which the form pre-fills, so an empty submission is a validation error
// rather than "unset").
function requiredNonNegativeInt(message: string) {
  return z
    .string()
    .trim()
    .transform((s, ctx) => {
      const n = Number(s);
      if (s === '' || !Number.isInteger(n) || n < 0) {
        ctx.addIssue({ code: 'custom', message });
        return z.NEVER;
      }
      return n;
    });
}

// Create form — includes code (immutable after creation).
export const catalogItemSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9_]{0,49}$/, 'Codice non valido: lettere maiuscole, cifre e underscore'),
  nameIt: z.string().trim().min(1, 'Nome obbligatorio').max(150, 'Nome troppo lungo'),
  sortOrder: requiredNonNegativeInt('Ordine: intero non negativo'),
  active: z.boolean(),
});

export type CatalogItemValues = z.input<typeof catalogItemSchema>;
export type CatalogItemParsed = z.output<typeof catalogItemSchema>;

// Edit form — code is immutable after creation, so PATCH omits it entirely
// (mirrors UpdateItemBody server-side).
export const editCatalogItemSchema = z.object({
  nameIt: z.string().trim().min(1, 'Nome obbligatorio').max(150, 'Nome troppo lungo'),
  sortOrder: requiredNonNegativeInt('Ordine: intero non negativo'),
  active: z.boolean(),
});

export type EditCatalogItemValues = z.input<typeof editCatalogItemSchema>;
export type EditCatalogItemParsed = z.output<typeof editCatalogItemSchema>;
