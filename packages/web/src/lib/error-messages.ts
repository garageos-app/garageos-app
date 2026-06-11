export const ERROR_MESSAGES: Record<string, string> = {
  'intervention.creation.date_future': 'Non è possibile registrare interventi futuri.',
  'intervention.creation.date_before_registration':
    "La data è precedente all'immatricolazione del veicolo.",
  'intervention.creation.user_no_location':
    "Il tuo account non è associato a una location. Contatta l'amministratore.",
  'vehicle.modification.archived': 'Il veicolo è archiviato e non accetta nuovi interventi.',
  'vehicle.creation.duplicate_vin': 'Esiste già un veicolo con questo VIN.',
  'vehicle.creation.duplicate_plate_warning': 'Esiste già un veicolo con questa targa.',
  'vehicle.creation.invalid_vin_checksum':
    'Il VIN non rispetta il checksum standard. Conferma se è un veicolo storico o agricolo.',
  'vehicle.creation.location_not_in_tenant': 'La sede selezionata non è valida.',
  'vehicle.certification.not_pending': 'Il veicolo non è più in attesa di certificazione.',
  'vehicle.certification.libretto_required':
    'Conferma di aver visionato il libretto di circolazione.',
  'users.me.update.empty_body': 'Nessuna modifica da salvare.',
  'users.me.update.unknown_field': 'Campo non modificabile.',
  'tenants.me.update.empty_body': 'Nessuna modifica da salvare.',
  'tenants.me.update.unknown_field': 'Campo non modificabile.',
  'tenants.me.locations.not_found': 'Sede non trovata.',
  'tenants.me.locations.update.empty_body': 'Nessuna modifica da salvare.',
  'tenants.me.locations.update.unknown_field': 'Campo non modificabile.',
  'tenants.me.locations.cannot_unset_primary':
    "Per cambiare la sede primaria, designa un'altra sede come primaria.",
  'tenants.me.locations.cannot_delete_primary':
    "Non puoi disattivare la sede primaria. Designa prima un'altra sede come primaria.",
  'tenants.me.locations.has_active_users':
    "Questa sede ha meccanici attivi. Riassegnali a un'altra sede prima di disattivarla.",
  'auth.forbidden.super_admin_required': 'Solo il Super Admin può modificare questi dati.',
  NOT_FOUND: 'Risorsa non trovata.',
  VALIDATION_ERROR: 'Controlla i campi evidenziati e riprova.',
};

export function translateError(code: string, fallback: string): string {
  return ERROR_MESSAGES[code] ?? fallback;
}
