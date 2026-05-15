import { z } from 'zod';

// Mirror of the backend PATCH /v1/tenants/me body schema, adapted for
// form inputs. Keep in sync with packages/api/src/routes/v1/tenants-update.ts.
//
// businessName + email are required (non-nullable in DB).
// Others are nullable: empty string in UI → null sent to backend.
export const tenantFormSchema = z.object({
  businessName: z
    .string()
    .trim()
    .min(1, 'Ragione sociale obbligatoria')
    .max(200, 'Ragione sociale troppo lunga'),
  addressLine: z
    .string()
    .trim()
    .max(255, 'Indirizzo troppo lungo')
    .transform((s) => (s === '' ? null : s)),
  city: z
    .string()
    .trim()
    .max(100, 'Città troppo lunga')
    .transform((s) => (s === '' ? null : s)),
  province: z
    .string()
    .trim()
    .transform((s) => (s === '' ? null : s.toUpperCase()))
    .pipe(
      z
        .string()
        .regex(/^[A-Z]{2}$/, 'Provincia: 2 lettere')
        .nullable(),
    ),
  postalCode: z
    .string()
    .trim()
    .transform((s) => (s === '' ? null : s))
    .pipe(
      z
        .string()
        .regex(/^[0-9]{5}$/, 'CAP: 5 cifre')
        .nullable(),
    ),
  phone: z
    .string()
    .trim()
    .transform((s) => (s === '' ? null : s))
    .pipe(
      z
        .string()
        .regex(/^[+]?[0-9 ()-]{6,30}$/, 'Telefono non valido')
        .nullable(),
    ),
  email: z.email('Email non valida'),
});

export type TenantFormValues = z.input<typeof tenantFormSchema>;
export type TenantFormParsed = z.output<typeof tenantFormSchema>;
