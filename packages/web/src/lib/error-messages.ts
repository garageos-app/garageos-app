export const ERROR_MESSAGES: Record<string, string> = {
  'intervention.creation.date_future': 'Non è possibile registrare interventi futuri.',
  'intervention.creation.date_before_registration':
    "La data è precedente all'immatricolazione del veicolo.",
  'intervention.creation.user_no_location':
    "Il tuo account non è associato a una location. Contatta l'amministratore.",
  'vehicle.modification.archived': 'Il veicolo è archiviato e non accetta nuovi interventi.',
  NOT_FOUND: 'Risorsa non trovata.',
  VALIDATION_ERROR: 'Controlla i campi evidenziati e riprova.',
};

export function translateError(code: string, fallback: string): string {
  return ERROR_MESSAGES[code] ?? fallback;
}
