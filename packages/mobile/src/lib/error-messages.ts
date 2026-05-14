const MESSAGES: Record<string, string> = {
  // Cognito SDK errors
  NotAuthorizedException: 'Email o password non corretti.',
  UserNotConfirmedException: "Account non confermato. Controlla l'email di verifica.",
  PasswordResetRequiredException: 'È necessario reimpostare la password.',
  LimitExceededException: 'Troppi tentativi. Riprova tra qualche minuto.',
  UserNotFoundException: 'Email o password non corretti.',
  InvalidPasswordException: 'Email o password non corretti.',

  // API domain codes
  'me.vehicle.not_found': 'Veicolo non trovato o non più di tua proprietà.',
  'vehicle.timeline.not_owner': 'Solo il proprietario attivo può consultare la timeline.',
  'auth.session_expired': "Sessione scaduta. Effettua di nuovo l'accesso.",
  'network.unreachable': 'Connessione assente. Controlla la rete.',
};

const FALLBACK = 'Si è verificato un errore. Riprova più tardi.';

export function mapErrorToUserMessage(code: string | undefined | null): string {
  if (!code) return FALLBACK;
  return MESSAGES[code] ?? FALLBACK;
}
