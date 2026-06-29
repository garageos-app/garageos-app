// Error-code → Italian message map for platform-admin tenant lifecycle actions.
// Mirrors the API_ERROR_MESSAGES pattern in CreateTenant.tsx.
// Code strings must match the RFC-7807 `code` field returned by the backend.

export const ACTION_ERROR_MESSAGES: Record<string, string> = {
  'tenant.invalid_status': "Operazione non consentita per lo stato attuale dell'officina.",
  'tenant.not_found': 'Officina non trovata.',
  'user.invitation.not_found': 'Nessun invito da rigenerare.',
  'user.invitation.already_accepted': "L'invito è già stato accettato.",
  'admin.tenant.rate_limited': 'Troppe richieste, riprova tra poco.',
  'user.last_super_admin':
    "Non puoi rimuovere l'ultimo amministratore. Promuovi prima un altro utente.",
  'user.location_required_for_mechanic': 'Un meccanico deve essere assegnato a una sede.',
  'user.location_invalid': 'Sede non valida o inattiva.',
  'user.not_found': 'Utente non trovato.',
  'tenant.vat_number_duplicate': 'P.IVA già in uso.',
  'tenant.vat_number_invalid': 'P.IVA non valida (11 cifre).',
  'tenants.me.update.empty_body': 'Nessuna modifica da salvare.',
  'tenants.me.update.unknown_field': 'Campo non modificabile.',
  'user.invitation.duplicate_pending': 'Esiste già un invito pendente per questa email.',
  'user.invitation.email_in_other_tenant': "Questa email è già usata in un'altra officina.",
  'auth.cognito_unavailable': 'Servizio temporaneamente non disponibile, riprova.',
};

export const GENERIC_ACTION_ERROR = 'Errore sconosciuto. Riprova.';
