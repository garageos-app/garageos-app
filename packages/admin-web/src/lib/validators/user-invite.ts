import { z } from 'zod';

// Schema for the invite-user dialog (POST /v1/admin/tenants/:id/users/invite).
// role is a closed enum — rendered as a select, so free-text errors are not
// expected in normal use; the default zod enum message covers edge cases.
export const userInviteSchema = z.object({
  email: z.string().trim().toLowerCase().email('Email non valida').max(255),
  firstName: z.string().trim().min(1, 'Nome obbligatorio').max(100),
  lastName: z.string().trim().min(1, 'Cognome obbligatorio').max(100),
  role: z.enum(['super_admin', 'mechanic']),
});

export type UserInviteValues = z.input<typeof userInviteSchema>;
export type UserInviteParsed = z.output<typeof userInviteSchema>;
