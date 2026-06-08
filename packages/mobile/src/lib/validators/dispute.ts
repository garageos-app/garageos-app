// BR-123 (category required) + BR-124 (description 20..2000). Mirrors the
// server-side CreateDisputeSchema so the client blocks before the request.
import type { DisputeReasonCategory } from '@/lib/types/intervention';

export type DisputeFormErrors = {
  reasonCategory?: string;
  description?: string;
};

export function validateDisputeForm(input: {
  reasonCategory: DisputeReasonCategory | null;
  description: string;
}): DisputeFormErrors {
  const errors: DisputeFormErrors = {};
  if (!input.reasonCategory) {
    errors.reasonCategory = 'Seleziona una motivazione.';
  }
  const len = input.description.trim().length;
  if (len < 20) {
    errors.description = 'La descrizione deve contenere almeno 20 caratteri.';
  } else if (len > 2000) {
    errors.description = 'La descrizione non può superare i 2000 caratteri.';
  }
  return errors;
}
