import { z } from 'zod';

// Schema mirrors the POST /v1/admin/tenants request body.
// Italian validation messages match UX copy guidelines.
export const createTenantSchema = z.object({
  businessName: z.string().trim().min(1, 'Ragione sociale obbligatoria').max(200),
  vatNumber: z
    .string()
    .trim()
    .regex(/^[0-9]{11}$/, 'P.IVA: 11 cifre'),
  email: z.string().trim().toLowerCase().email('Email non valida').max(255),
  ownerFirstName: z.string().trim().min(1, 'Nome obbligatorio').max(100),
  ownerLastName: z.string().trim().min(1, 'Cognome obbligatorio').max(100),
  ownerEmail: z.string().trim().toLowerCase().email('Email titolare non valida').max(255),
});

export type CreateTenantValues = z.input<typeof createTenantSchema>;
export type CreateTenantParsed = z.output<typeof createTenantSchema>;
