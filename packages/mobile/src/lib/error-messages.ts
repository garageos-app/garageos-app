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

  // Google sign-in error codes
  'auth.google.exchange_failed': 'Accesso con Google non riuscito. Riprova.',

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

  // Pending vehicle pre-registration (F-CLI-104)
  'vehicle.pending.duplicate_vin_certified':
    'Esiste già un veicolo registrato con questo telaio. Se è il tuo, chiedi il codice GarageOS alla tua officina.',
  'vehicle.creation.invalid_vin_checksum':
    'Il VIN non risulta valido. Controlla il libretto di circolazione.',

  // Dispute domain codes (F-CLI-206)
  'me.intervention.not_found': 'Intervento non trovato o non più di tua proprietà.',
  'intervention.dispute.not_owner':
    'Solo il proprietario attuale può contestare questo intervento.',
  'intervention.dispute.already_exists': 'Hai già una contestazione aperta per questo intervento.',
  'intervention.dispute.intervention_cancelled': 'Non puoi contestare un intervento annullato.',

  // Transfer domain codes (F-CLI-401→403). Codes verified against
  // api routes/v1/me-transfers.ts + lib/transfer-swap.ts.
  'transfer.not_found': 'Codice o trasferimento non valido. Controlla e riprova.',
  'transfer.creation.vehicle_not_found': 'Veicolo non trovato.',
  'transfer.creation.not_current_owner': 'Non risulti il proprietario attuale del veicolo.',
  'transfer.creation.vehicle_not_certified': 'Questo veicolo non può ancora essere trasferito.',
  'transfer.creation.already_pending': "C'è già un trasferimento attivo per questo veicolo.",
  'vehicle.archived': 'Veicolo archiviato: operazione non disponibile.',
  'transfer.acceptance.self_not_allowed': 'Questo trasferimento è stato avviato da te.',
  'transfer.acceptance.already_completed': 'Trasferimento già completato.',
  'transfer.acceptance.expired':
    'Codice scaduto: chiedi al venditore di avviare un nuovo trasferimento.',
  'transfer.acceptance.not_pending_recipient': 'Il trasferimento non è più accettabile.',
  'transfer.confirmation.not_from_customer':
    'Solo chi ha avviato il trasferimento può confermarlo.',
  'transfer.confirmation.expired': 'Trasferimento scaduto: avviane uno nuovo.',
  'transfer.confirmation.not_pending_seller':
    'Il trasferimento non è in attesa della tua conferma.',
  'transfer.confirmation.ownership_conflict': 'La proprietà del veicolo è cambiata nel frattempo.',
  'transfer.rejection.not_permitted': 'Non puoi annullare questo trasferimento.',
  'transfer.rejection.not_pending': 'Il trasferimento non è più annullabile.',

  // Personal deadline domain codes (F-CLI-306)
  'personal_deadline.vehicle_not_owned': 'Non sei il proprietario di questo veicolo.',
  'personal_deadline.not_found': 'Scadenza non trovata.',
  'personal_deadline.custom_label_required': "Specifica un'etichetta per la categoria 'Altro'.",
  'personal_deadline.update.empty_body': 'Nessuna modifica da salvare.',
  'personal_deadline.not_open': 'La scadenza è già completata o annullata.',
};

const FALLBACK = 'Si è verificato un errore. Riprova più tardi.';

export function mapErrorToUserMessage(code: string | undefined | null): string {
  if (!code) return FALLBACK;
  return MESSAGES[code] ?? FALLBACK;
}
