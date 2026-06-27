// NOTE: this file intentionally diverges from packages/web/src/lib/auth-errors.ts.
// The platform-admins pool policy requires min-10 chars + case + digit, so
// InvalidPasswordException needs a specific, accurate message here.
// The shared-module extraction is logged as tech debt (out of scope for this PR).
const COGNITO_ERROR_MESSAGES: Record<string, string> = {
  NotAuthorizedException: 'Email o password non corretti',
  UserNotFoundException: 'Email o password non corretti',
  PasswordResetRequiredException: 'Devi reimpostare la password. Contatta il supporto.',
  UserNotConfirmedException: 'Account non ancora attivato. Controlla la tua email.',
  LimitExceededException: 'Troppi tentativi. Riprova tra qualche minuto.',
  TooManyRequestsException: 'Troppi tentativi. Riprova tra qualche minuto.',
  InvalidPasswordException:
    'La password non rispetta i requisiti di sicurezza (almeno 10 caratteri, con maiuscole, minuscole e numeri).',
};

export function mapCognitoError(err: unknown): string {
  if (err && typeof err === 'object' && 'name' in err && typeof err.name === 'string') {
    const mapped = COGNITO_ERROR_MESSAGES[err.name];
    if (mapped) return mapped;
  }
  return 'Impossibile contattare il server. Riprova.';
}
