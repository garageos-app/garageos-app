export const ERROR_MESSAGES: Record<string, string> = {
  'intervention.creation.date_future': 'Non è possibile registrare interventi futuri.',
  'intervention.creation.date_before_registration':
    "La data è precedente all'immatricolazione del veicolo.",
  'intervention.creation.user_no_location':
    "Il tuo account non è associato a una location. Contatta l'amministratore.",
  'vehicle.modification.archived': 'Il veicolo è archiviato e non accetta nuovi interventi.',
  'users.me.update.empty_body': 'Nessuna modifica da salvare.',
  'users.me.update.unknown_field': 'Campo non modificabile.',
  'tenants.me.update.empty_body': 'Nessuna modifica da salvare.',
  'tenants.me.update.unknown_field': 'Campo non modificabile.',
  'auth.forbidden.super_admin_required': 'Solo il Super Admin può modificare questi dati.',
  NOT_FOUND: 'Risorsa non trovata.',
  VALIDATION_ERROR: 'Controlla i campi evidenziati e riprova.',
};

export function translateError(code: string, fallback: string): string {
  return ERROR_MESSAGES[code] ?? fallback;
}
