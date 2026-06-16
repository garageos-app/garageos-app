// Pure validator for the create/edit personal-deadline form. Mirrors the backend
// rules in packages/database/src/validators/personal-deadline.ts but is
// hand-written — no Zod in the RN bundle. date-fns (already a dep) handles
// real-date validity and past-date comparison.
// Business rules cited: BR-292 (at least one active channel), BR-293 (at least
// one reminder), BR-294 (customLabel required when category is 'other').
import { isBefore, isValid, parse, startOfToday } from 'date-fns';

import type { PersonalDeadlineCategory } from '@/lib/types/personalDeadline';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type PersonalDeadlineFormInput = {
  vehicleId: string;
  category: PersonalDeadlineCategory;
  customLabel: string;
  dueDate: string; // YYYY-MM-DD
  reminderLeadDays: number[];
  reminderDailyTailDays: number; // 0 = tail off
  notifyPush: boolean;
  notifyEmail: boolean;
  recurrenceMonths: number; // 0 = non-recurring
  notes: string;
};

export type PersonalDeadlineFormErrors = Partial<
  Record<keyof PersonalDeadlineFormInput, string> & { form: string }
>;

export function validatePersonalDeadlineForm(
  input: PersonalDeadlineFormInput,
  options?: { allowPastDate?: boolean },
): PersonalDeadlineFormErrors {
  const errors: PersonalDeadlineFormErrors = {};

  if (!input.vehicleId.trim()) {
    errors.vehicleId = 'Seleziona un veicolo';
  }

  // BR-294: customLabel is required when category is 'other'.
  const customLabel = input.customLabel.trim();
  if (input.category === 'other' && !customLabel) {
    errors.customLabel = "Specifica un'etichetta";
  } else if (customLabel.length > 80) {
    // Mirror backend max(80) — checked even when category is not 'other'.
    errors.customLabel = 'Massimo 80 caratteri';
  }

  const dueDate = input.dueDate.trim();
  if (!dueDate) {
    errors.dueDate = 'Data obbligatoria';
  } else if (!DATE_RE.test(dueDate) || !isValid(parse(dueDate, 'yyyy-MM-dd', new Date()))) {
    errors.dueDate = 'Data non valida (AAAA-MM-GG)';
  } else if (
    !options?.allowPastDate &&
    isBefore(parse(dueDate, 'yyyy-MM-dd', new Date()), startOfToday())
  ) {
    // Create-mode nicety only: an overdue deadline has a past dueDate, so edit
    // mode must allow it (the server has no past-date guard).
    errors.dueDate = 'La data non può essere nel passato';
  }

  // BR-293: at least one reminder must be active (lead days OR daily tail).
  if (input.reminderLeadDays.length === 0 && input.reminderDailyTailDays === 0) {
    errors.form = 'Scegli almeno un promemoria';
  }

  // BR-292: channel-AND — a deadline with no active channel would never deliver.
  // The reminder error takes precedence, so don't overwrite a form error set above.
  if (!errors.form && !input.notifyPush && !input.notifyEmail) {
    errors.form = 'Attiva almeno un canale di notifica (push o email)';
  }

  if (input.reminderDailyTailDays < 0 || input.reminderDailyTailDays > 30) {
    errors.reminderDailyTailDays = 'La coda può essere al massimo 30 giorni';
  }

  if (
    input.recurrenceMonths !== 0 &&
    (input.recurrenceMonths < 1 || input.recurrenceMonths > 120)
  ) {
    errors.recurrenceMonths = 'Ricorrenza tra 1 e 120 mesi';
  }

  if (input.notes.trim().length > 500) {
    errors.notes = 'Massimo 500 caratteri';
  }

  return errors;
}
