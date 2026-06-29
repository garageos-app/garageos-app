import { z } from 'zod';

// Schema mirrors the PATCH /v1/admin/tenants/:id request body.
// Pattern follows tenant-create.ts; empty string on nullable fields → null.
// province is normalised to uppercase before validation (user may type 'mi' → 'MI').
export const tenantProfileSchema = z.object({
  businessName: z.string().trim().min(1, 'Ragione sociale obbligatoria').max(200),
  vatNumber: z.string().trim().min(1, 'P.IVA obbligatoria').max(20),
  email: z.string().trim().toLowerCase().email('Email non valida').max(255),
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
  addressLine: z
    .string()
    .trim()
    .max(255, 'Indirizzo troppo lungo')
    .transform((s): string | null => (s === '' ? null : s)),
  city: z
    .string()
    .trim()
    .max(100, 'Città troppo lunga')
    .transform((s): string | null => (s === '' ? null : s)),
  province: z
    .string()
    .trim()
    .transform((s) => (s === '' ? null : s.toUpperCase()))
    .pipe(
      z
        .string()
        .regex(/^[A-Z]{2}$/, 'Sigla provincia (2 lettere maiuscole)')
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
});

export type TenantProfileValues = z.input<typeof tenantProfileSchema>;
export type TenantProfileParsed = z.output<typeof tenantProfileSchema>;
