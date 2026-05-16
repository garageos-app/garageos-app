import { z } from 'zod';

// Policy mirror of the Cognito officine user pool: see
// infrastructure/lib/constructs/cognito.ts:51-57.
// minLength: 10, requireLowercase: true, requireUppercase: true,
// requireDigits: true, requireSymbols: false.
// If the CDK construct changes, update this schema in lockstep —
// Cognito remains the ultimate authority; this is client-side first line.
export const passwordPolicySchema = z
  .string()
  .min(10, 'Almeno 10 caratteri')
  .regex(/[a-z]/, 'Almeno una lettera minuscola')
  .regex(/[A-Z]/, 'Almeno una lettera maiuscola')
  .regex(/[0-9]/, 'Almeno un numero');

export const changePasswordFormSchema = z
  .object({
    oldPassword: z.string().min(1, 'Campo obbligatorio'),
    newPassword: passwordPolicySchema,
    confirmPassword: z.string().min(1, 'Campo obbligatorio'),
  })
  // Refine order is intentional: confirm-mismatch is checked first because
  // mistyping the confirm field is the most common user error — surface it
  // before the reuse-old check, which is rarer and lower-priority for UX.
  .refine((v) => v.newPassword === v.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Le password non coincidono',
  })
  .refine((v) => v.newPassword !== v.oldPassword, {
    path: ['newPassword'],
    message: 'La nuova password deve essere diversa dalla precedente',
  });

export type ChangePasswordFormValues = z.infer<typeof changePasswordFormSchema>;
