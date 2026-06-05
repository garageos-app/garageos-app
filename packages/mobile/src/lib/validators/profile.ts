// Pure validator for the profile edit form. Mirrors the backend PATCH rules
// (firstName/lastName required 1..100, phone optional matching ^\+?[0-9]{8,20}$).
// No Zod in mobile deps; mirror validators/signup.ts.
const PHONE_RE = /^\+?[0-9]{8,20}$/;

export type ProfileFormInput = {
  firstName: string;
  lastName: string;
  phone: string;
};

export type ProfileFormErrors = Partial<Record<keyof ProfileFormInput, string>>;

export function validateProfileForm(input: ProfileFormInput): ProfileFormErrors {
  const errors: ProfileFormErrors = {};

  const firstName = input.firstName.trim();
  if (!firstName) errors.firstName = 'Nome obbligatorio';
  else if (firstName.length > 100) errors.firstName = 'Massimo 100 caratteri';

  const lastName = input.lastName.trim();
  if (!lastName) errors.lastName = 'Cognome obbligatorio';
  else if (lastName.length > 100) errors.lastName = 'Massimo 100 caratteri';

  const phone = input.phone.trim();
  if (phone && !PHONE_RE.test(phone)) errors.phone = 'Telefono non valido';

  return errors;
}
