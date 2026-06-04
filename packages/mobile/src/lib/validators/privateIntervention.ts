// Pure validator for the create-private-intervention form. Mirrors the backend
// rules in routes/v1/me-private-interventions.ts (custom_type 1..150, date
// YYYY-MM-DD not-future per BR-069, odometer 0..9_999_999, description 1..5000).
// No Zod in mobile deps; date-fns (already a dep) handles real-date validity.
// The not-future check uses local midnight; the server's date_future code is
// authoritative for the rare timezone-boundary case.
import { isAfter, isValid, parse, startOfToday } from 'date-fns';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type PrivateInterventionFormInput = {
  customType: string;
  interventionDate: string;
  odometerKm: string;
  description: string;
};

export type PrivateInterventionFormErrors = Partial<
  Record<keyof PrivateInterventionFormInput, string>
>;

export function validatePrivateInterventionForm(
  input: PrivateInterventionFormInput,
): PrivateInterventionFormErrors {
  const errors: PrivateInterventionFormErrors = {};

  const customType = input.customType.trim();
  if (!customType) errors.customType = 'Tipo obbligatorio';
  else if (customType.length > 150) errors.customType = 'Massimo 150 caratteri';

  const date = input.interventionDate.trim();
  if (!date) {
    errors.interventionDate = 'Data obbligatoria';
  } else if (!DATE_RE.test(date) || !isValid(parse(date, 'yyyy-MM-dd', new Date()))) {
    errors.interventionDate = 'Data non valida (AAAA-MM-GG)';
  } else if (isAfter(parse(date, 'yyyy-MM-dd', new Date()), startOfToday())) {
    errors.interventionDate = 'Non puoi registrare una data futura';
  }

  const km = input.odometerKm.trim();
  if (km) {
    if (!/^\d+$/.test(km)) errors.odometerKm = 'Inserisci solo numeri';
    else if (Number(km) > 9_999_999) errors.odometerKm = 'Valore troppo grande';
  }

  const description = input.description.trim();
  if (!description) errors.description = 'Descrizione obbligatoria';
  else if (description.length > 5000) errors.description = 'Massimo 5000 caratteri';

  return errors;
}
