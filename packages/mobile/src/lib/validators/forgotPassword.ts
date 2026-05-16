// Pure validator for the forgot-password form. Mirrors validators/signup.ts.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ForgotPasswordInput = { email: string };
export type ForgotPasswordErrors = Partial<Record<keyof ForgotPasswordInput, string>>;

export function validateForgotPassword(input: ForgotPasswordInput): ForgotPasswordErrors {
  const errors: ForgotPasswordErrors = {};
  if (!input.email) {
    errors.email = 'Email obbligatoria';
  } else if (!EMAIL_REGEX.test(input.email)) {
    errors.email = 'Email non valida';
  }
  return errors;
}
