import { z } from 'zod';

// Mirror of the backend PATCH /v1/users/me body schema, adapted for
// form inputs where empty string represents the cleared/null state.
// Keep in sync with packages/api/src/routes/v1/users-update.ts.
//
// firstName/lastName are required (non-nullable in DB).
// phone is optional/nullable: empty string in UI → null sent to backend.
export const profileFormSchema = z.object({
  firstName: z.string().trim().min(1, 'Nome obbligatorio').max(100, 'Nome troppo lungo'),
  lastName: z.string().trim().min(1, 'Cognome obbligatorio').max(100, 'Cognome troppo lungo'),
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
});

export type ProfileFormValues = z.input<typeof profileFormSchema>;
export type ProfileFormParsed = z.output<typeof profileFormSchema>;
