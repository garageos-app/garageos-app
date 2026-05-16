// Pure validator for the reset-password form. Mirrors validators/signup.ts
// password policy and adds 6-digit Cognito confirmation-code validation.
// The Cognito clienti pool policy is the authoritative gate (see
// infrastructure/lib/constructs/cognito.ts:86-91); this client-side check is
// best-effort UX. Server rejection surfaces as InvalidPasswordException.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_REGEX = /^\d{6}$/;

export type ResetPasswordInput = {
  email: string;
  code: string;
  password: string;
  confirmPassword: string;
};

export type ResetPasswordErrors = Partial<Record<keyof ResetPasswordInput, string>>;

export function validateResetPassword(input: ResetPasswordInput): ResetPasswordErrors {
  const errors: ResetPasswordErrors = {};

  if (!input.email) {
    errors.email = 'Email obbligatoria';
  } else if (!EMAIL_REGEX.test(input.email)) {
    errors.email = 'Email non valida';
  }

  if (!input.code) {
    errors.code = 'Codice obbligatorio';
  } else if (!CODE_REGEX.test(input.code)) {
    errors.code = 'Il codice deve essere di 6 cifre';
  }

  if (!input.password) {
    errors.password = 'Password obbligatoria';
  } else if (input.password.length < 8) {
    errors.password = 'Almeno 8 caratteri';
  } else if (!/[a-z]/.test(input.password)) {
    errors.password = 'Almeno una lettera minuscola';
  } else if (!/[0-9]/.test(input.password)) {
    errors.password = 'Almeno un numero';
  }

  if (!input.confirmPassword) {
    errors.confirmPassword = 'Conferma la password';
  } else if (input.password !== input.confirmPassword) {
    errors.confirmPassword = 'Le password non coincidono';
  }

  return errors;
}
