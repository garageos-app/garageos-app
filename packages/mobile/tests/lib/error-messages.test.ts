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
});
