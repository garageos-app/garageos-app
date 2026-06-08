const MESSAGES: Record<string, string> = {
  // Cognito SDK errors
  NotAuthorizedException: 'Email o password non corretti.',
  UserNotConfirmedException: "Account non confermato. Controlla l'email di verifica.",
  PasswordResetRequiredException: 'È necessario reimpostare la password.',
  LimitExceededException: 'Troppi tentativi. Riprova tra qualche minuto.',
  UserNotFoundException: 'Email o password non corretti.',
  InvalidPasswordException: 'Email o password non corretti.',
  CodeMismatchException: "Codice non valido. Controlla l'email e riprova.",
  ExpiredCodeException: 'Il codice è scaduto. Richiedi un nuovo codice.',
  CodeDeliveryFailureException: "Errore nell'invio del codice. Riprova tra qualche minuto.",

  // API domain codes
  'me.vehicle.not_found': 'Veicolo non trovato o non più di tua proprietà.',
  // Claim vehicle domain codes (F-CLI-101)
  'me.vehicle.claim.code_not_found': 'Nessun veicolo trovato per questo codice.',
  'me.vehicle.claim.owned_by_other': 'Questo veicolo è già associato a un altro account.',
  'me.vehicle.claim.pending': "Veicolo non ancora certificato dall'officina.",
  'me.vehicle.claim.archived': 'Veicolo archiviato: non può essere aggiunto.',
  'vehicle.timeline.not_owner': 'Solo il proprietario attivo può consultare la timeline.',
  'auth.session_expired': "Sessione scaduta. Effettua di nuovo l'accesso.",
  'network.unreachable': 'Connessione assente. Controlla la rete.',

  // Signup domain codes (F-CLI-001)
  'auth.signup.email_already_active':
    'Un account con questa email è già registrato. Effettua il login.',
  'auth.signup.password_policy_violation':
    'La password non rispetta i requisiti: almeno 8 caratteri, una lettera minuscola e un numero.',
  'auth.signup.tenant_signup_not_supported': 'La registrazione officina non è ancora disponibile.',
  'auth.signup.cognito_unavailable':
    'Servizio di autenticazione temporaneamente non disponibile. Riprova tra qualche istante.',
  'auth.signup.rate_limited': 'Troppi tentativi di registrazione. Riprova tra qualche minuto.',
  'auth.resend_verification.rate_limited': 'Troppi tentativi. Riprova tra qualche minuto.',

  // Dispute domain codes (F-CLI-206)
  'me.intervention.not_found': 'Intervento non trovato o non più di tua proprietà.',
  'intervention.dispute.not_owner':
    'Solo il proprietario attuale può contestare questo intervento.',
  'intervention.dispute.already_exists': 'Hai già una contestazione aperta per questo intervento.',
  'intervention.dispute.intervention_cancelled': 'Non puoi contestare un intervento annullato.',
};

const FALLBACK = 'Si è verificato un errore. Riprova più tardi.';

export function mapErrorToUserMessage(code: string | undefined | null): string {
  if (!code) return FALLBACK;
  return MESSAGES[code] ?? FALLBACK;
}
