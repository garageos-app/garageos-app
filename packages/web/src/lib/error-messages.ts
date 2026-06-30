// IT-strings — hardcoded, no i18n in this app.
// Single source for the generic terminal-denial copy (backend code
// `auth.session.inactive`): shown both on the AccountInactive screen and in
// the toast that fires if a mutation hits the inactive 401 (see api-client).
// Generic by design (BR-210): must not reveal user-disabled vs tenant-suspended.
export const ACCOUNT_INACTIVE_MESSAGE =
  'Il tuo accesso non è al momento disponibile. Se ritieni che si tratti di un errore, contatta il supporto.';

export const ERROR_MESSAGES: Record<string, string> = {
  'auth.session.inactive': ACCOUNT_INACTIVE_MESSAGE,
  'intervention.creation.date_future': 'Non è possibile registrare interventi futuri.',
  'intervention.creation.date_before_registration':
    "La data è precedente all'immatricolazione del veicolo.",
  'vehicle.modification.archived': 'Il veicolo è archiviato e non accetta nuovi interventi.',
  'vehicle.creation.duplicate_vin': 'Esiste già un veicolo con questo VIN.',
  'vehicle.creation.duplicate_plate_warning': 'Esiste già un veicolo con questa targa.',
  'vehicle.creation.invalid_vin_checksum':
    'Il VIN non rispetta il checksum standard. Conferma se è un veicolo storico o agricolo.',
  'vehicle.certification.not_pending': 'Il veicolo non è più in attesa di certificazione.',
  'vehicle.certification.libretto_required':
    'Conferma di aver visionato il libretto di circolazione.',
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
