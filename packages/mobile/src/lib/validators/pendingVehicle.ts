// Pure validator for the pending-vehicle pre-registration form (F-CLI-104).
// The caller normalizes the input first (trim all fields; uppercase vin/plate),
// so this checks already-normalized strings; the server stays authoritative.

// BR-001 VIN shape: 17 chars, no I/O/Q. The ISO 3779 checksum is NOT
// replicated client-side — the server's vehicle.creation.invalid_vin_checksum
// 400 is mapped into the form banner.
export const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

// Mirror of the API's ItalianPlateSchema (AB123CD).
export const PLATE_RE = /^[A-Z]{2}[0-9]{3}[A-Z]{2}$/;

// Mirror of the API's date-only format (YYYY-MM-DD). The form feeds this from
// a date picker, so the regex is a guard, not the primary input control.
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type PendingVehicleFormValues = {
  vin: string;
  plate: string;
  make: string;
  model: string;
  year: string;
  vehicleType: string;
  fuelType: string;
  // Optional owner-declared technical fields. All raw form strings; empty
  // string means "not provided" and is skipped by both validation and the
  // request body builder.
  version: string;
  registrationDate: string;
  engineDisplacement: string;
  powerKw: string;
  color: string;
};

export type PendingVehicleFormErrors = Partial<Record<keyof PendingVehicleFormValues, string>>;

const REQUIRED = 'Campo obbligatorio';

export function validatePendingVehicleForm(
  values: PendingVehicleFormValues,
): PendingVehicleFormErrors {
  const errors: PendingVehicleFormErrors = {};

  if (!values.vin) errors.vin = REQUIRED;
  else if (!VIN_RE.test(values.vin)) {
    errors.vin = 'Il telaio (VIN) deve essere di 17 caratteri (senza I, O, Q)';
  }

  if (!values.plate) errors.plate = REQUIRED;
  else if (!PLATE_RE.test(values.plate)) {
    errors.plate = 'Formato targa non valido (esempio: AB123CD)';
  }

  if (!values.make) errors.make = REQUIRED;
  if (!values.model) errors.model = REQUIRED;

  // BR-007: year between 1900 and next year (server-side mirror).
  if (!values.year) errors.year = REQUIRED;
  else {
    const year = Number(values.year);
    const maxYear = new Date().getFullYear() + 1;
    if (!/^\d+$/.test(values.year) || year < 1900 || year > maxYear) {
      errors.year = 'Anno non valido';
    }
  }

  if (!values.vehicleType) errors.vehicleType = REQUIRED;
  if (!values.fuelType) errors.fuelType = REQUIRED;

  // Optional technical fields — validated only when the owner filled them in.
  // Limits mirror the API's CreatePendingVehicleSchema.
  if (values.version && values.version.length > 150) {
    errors.version = 'Massimo 150 caratteri';
  }

  if (values.registrationDate) {
    const d = values.registrationDate;
    const ts = Date.parse(`${d}T00:00:00Z`);
    if (!DATE_RE.test(d) || Number.isNaN(ts)) {
      errors.registrationDate = 'Data non valida';
    } else if (ts > Date.now()) {
      errors.registrationDate = 'La data non può essere futura';
    }
  }

  if (values.engineDisplacement) {
    const n = Number(values.engineDisplacement);
    if (!/^\d+$/.test(values.engineDisplacement) || n <= 0) {
      errors.engineDisplacement = 'Inserisci un numero intero positivo (cc)';
    }
  }

  if (values.powerKw) {
    const n = Number(values.powerKw);
    if (!/^\d+$/.test(values.powerKw) || n <= 0) {
      errors.powerKw = 'Inserisci un numero intero positivo (kW)';
    }
  }

  if (values.color && values.color.length > 50) {
    errors.color = 'Massimo 50 caratteri';
  }

  return errors;
}
