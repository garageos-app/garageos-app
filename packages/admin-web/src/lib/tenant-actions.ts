// Error-code → Italian message map for platform-admin tenant lifecycle actions.
// Mirrors the API_ERROR_MESSAGES pattern in CreateTenant.tsx.
// Code strings must match the RFC-7807 `code` field returned by the backend.

export const ACTION_ERROR_MESSAGES: Record<string, string> = {
  'tenant.invalid_status': "Operazione non consentita per lo stato attuale dell'officina.",
  'tenant.not_found': 'Officina non trovata.',
  'user.invitation.not_found': 'Nessun invito da rigenerare.',
  'user.invitation.already_accepted': "L'invito è già stato accettato.",
  'admin.tenant.rate_limited': 'Troppe richieste, riprova tra poco.',
};

export const GENERIC_ACTION_ERROR = 'Errore sconosciuto. Riprova.';
