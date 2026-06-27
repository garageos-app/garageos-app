const COGNITO_ERROR_MESSAGES: Record<string, string> = {
  NotAuthorizedException: 'Email o password non corretti',
  UserNotFoundException: 'Email o password non corretti',
  PasswordResetRequiredException: 'Devi reimpostare la password. Contatta il supporto.',
  UserNotConfirmedException: 'Account non ancora attivato. Controlla la tua email.',
  LimitExceededException: 'Troppi tentativi. Riprova tra qualche minuto.',
  TooManyRequestsException: 'Troppi tentativi. Riprova tra qualche minuto.',
};

export function mapCognitoError(err: unknown): string {
  if (err && typeof err === 'object' && 'name' in err && typeof err.name === 'string') {
    const mapped = COGNITO_ERROR_MESSAGES[err.name];
    if (mapped) return mapped;
  }
  return 'Impossibile contattare il server. Riprova.';
}
