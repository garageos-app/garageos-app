import { mapErrorToUserMessage } from '@/lib/error-messages';

describe('mapErrorToUserMessage', () => {
  it('maps NotAuthorizedException', () => {
    expect(mapErrorToUserMessage('NotAuthorizedException')).toBe('Email o password non corretti.');
  });

  it('maps me.vehicle.not_found', () => {
    expect(mapErrorToUserMessage('me.vehicle.not_found')).toBe(
      'Veicolo non trovato o non più di tua proprietà.',
    );
  });

  it('maps unknown codes to fallback', () => {
    expect(mapErrorToUserMessage('unknown.code')).toBe(
      'Si è verificato un errore. Riprova più tardi.',
    );
  });

  it('maps undefined to fallback', () => {
    expect(mapErrorToUserMessage(undefined)).toBe('Si è verificato un errore. Riprova più tardi.');
  });

  it('maps auth.signup.email_already_active', () => {
    expect(mapErrorToUserMessage('auth.signup.email_already_active')).toBe(
      'Un account con questa email è già registrato. Effettua il login.',
    );
  });

  it('maps auth.signup.password_policy_violation', () => {
    expect(mapErrorToUserMessage('auth.signup.password_policy_violation')).toBe(
      'La password non rispetta i requisiti: almeno 8 caratteri, una lettera minuscola e un numero.',
    );
  });

  it('maps auth.signup.tenant_signup_not_supported', () => {
    expect(mapErrorToUserMessage('auth.signup.tenant_signup_not_supported')).toBe(
      'La registrazione officina non è ancora disponibile.',
    );
  });

  it('maps auth.signup.cognito_unavailable', () => {
    expect(mapErrorToUserMessage('auth.signup.cognito_unavailable')).toBe(
      'Servizio di autenticazione temporaneamente non disponibile. Riprova tra qualche istante.',
    );
  });

  it('maps auth.signup.rate_limited', () => {
    expect(mapErrorToUserMessage('auth.signup.rate_limited')).toBe(
      'Troppi tentativi di registrazione. Riprova tra qualche minuto.',
    );
  });

  it('maps auth.resend_verification.rate_limited', () => {
    expect(mapErrorToUserMessage('auth.resend_verification.rate_limited')).toBe(
      'Troppi tentativi. Riprova tra qualche minuto.',
    );
  });

  it('maps CodeMismatchException for password reset', () => {
    expect(mapErrorToUserMessage('CodeMismatchException')).toBe(
      "Codice non valido. Controlla l'email e riprova.",
    );
  });

  it('maps ExpiredCodeException for password reset', () => {
    expect(mapErrorToUserMessage('ExpiredCodeException')).toBe(
      'Il codice è scaduto. Richiedi un nuovo codice.',
    );
  });

  it('maps CodeDeliveryFailureException for password reset', () => {
    expect(mapErrorToUserMessage('CodeDeliveryFailureException')).toBe(
      "Errore nell'invio del codice. Riprova tra qualche minuto.",
    );
  });

  it('maps the claim domain codes to Italian copy', () => {
    expect(mapErrorToUserMessage('me.vehicle.claim.code_not_found')).toMatch(/Nessun veicolo/);
    expect(mapErrorToUserMessage('me.vehicle.claim.owned_by_other')).toMatch(/altro account/);
    expect(mapErrorToUserMessage('me.vehicle.claim.pending')).toMatch(/non ancora certificato/);
    expect(mapErrorToUserMessage('me.vehicle.claim.archived')).toMatch(/archiviato/);
  });

  it('maps the transfer domain codes (F-CLI-401)', () => {
    expect(mapErrorToUserMessage('transfer.not_found')).toBe(
      'Codice o trasferimento non valido. Controlla e riprova.',
    );
    expect(mapErrorToUserMessage('transfer.acceptance.expired')).toBe(
      'Codice scaduto: chiedi al venditore di avviare un nuovo trasferimento.',
    );
    expect(mapErrorToUserMessage('transfer.creation.already_pending')).toBe(
      "C'è già un trasferimento attivo per questo veicolo.",
    );
    expect(mapErrorToUserMessage('transfer.confirmation.ownership_conflict')).toBe(
      'La proprietà del veicolo è cambiata nel frattempo.',
    );
  });

  // Personal deadline domain codes (F-CLI-306)
  it('maps personal_deadline.not_found', () => {
    expect(mapErrorToUserMessage('personal_deadline.not_found')).toBe('Scadenza non trovata.');
  });

  it('maps personal_deadline.not_open', () => {
    expect(mapErrorToUserMessage('personal_deadline.not_open')).toBe(
      'La scadenza è già completata o annullata.',
    );
  });

  it('maps personal_deadline.vehicle_not_owned', () => {
    expect(mapErrorToUserMessage('personal_deadline.vehicle_not_owned')).toBe(
      'Non sei il proprietario di questo veicolo.',
    );
  });

  it('maps personal_deadline.custom_label_required', () => {
    expect(mapErrorToUserMessage('personal_deadline.custom_label_required')).toBe(
      "Specifica un'etichetta per la categoria 'Altro'.",
    );
  });

  it('maps personal_deadline.update.empty_body', () => {
    expect(mapErrorToUserMessage('personal_deadline.update.empty_body')).toBe(
      'Nessuna modifica da salvare.',
    );
  });

  it('returns fallback for unknown personal_deadline subcode', () => {
    expect(mapErrorToUserMessage('personal_deadline.nope')).toBe(
      'Si è verificato un errore. Riprova più tardi.',
    );
  });
});
