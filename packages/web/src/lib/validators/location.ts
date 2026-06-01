import { z } from 'zod';

// Mirror of the backend POST /v1/tenants/me/locations body schema, adapted
// for form inputs. Keep in sync with
// packages/api/src/routes/v1/tenants-locations-write.ts.
//
// name/addressLine/city/province/postalCode are required (NOT NULL in DB).
// country defaults to IT. phone/email optional: empty string in UI → null.
export const locationFormSchema = z.object({
  name: z.string().trim().min(1, 'Nome obbligatorio').max(200, 'Nome troppo lungo'),
  addressLine: z
    .string()
    .trim()
    .min(1, 'Indirizzo obbligatorio')
    .max(255, 'Indirizzo troppo lungo'),
  city: z.string().trim().min(1, 'Città obbligatoria').max(100, 'Città troppo lunga'),
  province: z
    .string()
    .trim()
    .min(1, 'Provincia obbligatoria')
    .transform((s) => s.toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{2}$/, 'Provincia: 2 lettere')),
  postalCode: z
    .string()
    .trim()
    .min(1, 'CAP obbligatorio')
    .pipe(z.string().regex(/^[0-9]{5}$/, 'CAP: 5 cifre')),
  country: z
    .string()
    .trim()
    .transform((s) => (s === '' ? 'IT' : s.toUpperCase()))
    .pipe(z.string().regex(/^[A-Z]{2}$/, 'Country: 2 lettere')),
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
  email: z
    .string()
    .trim()
    .transform((s) => (s === '' ? null : s))
    .pipe(z.email('Email non valida').nullable()),
});

export type LocationFormValues = z.input<typeof locationFormSchema>;
export type LocationFormParsed = z.output<typeof locationFormSchema>;
