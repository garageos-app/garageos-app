// Pure validator for the create/edit private-intervention form. Conditional on
// the type selection: a catalog type (UUID selectedKey) requires >= 1 checklist
// item (BR-300 parity); the free-text "Altro" path requires a customType
// (1..150). Mirrors the backend rules in routes/v1/me-private-interventions.ts
// (date YYYY-MM-DD not-future per BR-069, odometer 0..9_999_999, description
// 1..5000). No Zod in mobile deps; date-fns (already a dep) validates real dates.
import { isAfter, isValid, parse, startOfToday } from 'date-fns';

// Sentinel selection key for the free-text ("Altro") branch. Stored in the same
// selectedKey state as catalog UUIDs; 'altro' can never collide with a UUID.
export const ALTRO_TYPE_KEY = 'altro';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type PrivateInterventionFormInput = {
  selectedKey: string | null;
  customType: string;
  checklistItemIds: string[];
  interventionDate: string;
  odometerKm: string;
  description: string;
};

export type PrivateInterventionFormErrors = Partial<{
  type: string;
  customType: string;
  checklistItemIds: string;
  interventionDate: string;
  odometerKm: string;
  description: string;
}>;

export function validatePrivateInterventionForm(
  input: PrivateInterventionFormInput,
): PrivateInterventionFormErrors {
  const errors: PrivateInterventionFormErrors = {};

  if (input.selectedKey === null) {
    errors.type = 'Seleziona un tipo di intervento';
  } else if (input.selectedKey === ALTRO_TYPE_KEY) {
    const customType = input.customType.trim();
    if (!customType) errors.customType = 'Tipo obbligatorio';
    else if (customType.length > 150) errors.customType = 'Massimo 150 caratteri';
  } else if (input.checklistItemIds.length < 1) {
    // Catalog type -> checklist mandatory (BR-300 parity with officina).
    errors.checklistItemIds = 'Seleziona almeno una voce';
  }

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
