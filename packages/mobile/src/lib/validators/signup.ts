// Pure validator for the signup form. No Zod (not in mobile deps);
// mirror the inline pattern from app/login.tsx but extracted for testability.
// The Cognito clienti pool policy is the authoritative gate (minLength 8,
// requireLowercase, requireDigits — see infrastructure/lib/constructs/cognito.ts:86-91).
// Client-side validation is best-effort UX; server rejection surfaces as
// auth.signup.password_policy_violation if a request slips through.

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type SignupFormInput = {
  email: string;
  password: string;
  confirmPassword: string;
  firstName: string;
  lastName: string;
};

export type SignupFormErrors = Partial<Record<keyof SignupFormInput, string>>;

export function validateSignupForm(input: SignupFormInput): SignupFormErrors {
  const errors: SignupFormErrors = {};

  if (!input.email) {
    errors.email = 'Email obbligatoria';
  } else if (!EMAIL_REGEX.test(input.email)) {
    errors.email = 'Email non valida';
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

  if (!input.firstName.trim()) {
    errors.firstName = 'Nome obbligatorio';
  }
  if (!input.lastName.trim()) {
    errors.lastName = 'Cognome obbligatorio';
  }

  return errors;
}
