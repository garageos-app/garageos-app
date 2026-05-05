import { describe, it, expect } from 'vitest';
import { mapCognitoError } from '@/lib/auth-errors';

describe('mapCognitoError', () => {
  it('maps NotAuthorizedException to generic invalid-credentials message', () => {
    expect(mapCognitoError({ name: 'NotAuthorizedException' })).toBe(
      'Email o password non corretti',
    );
  });

  it('maps UserNotFoundException to the same message (avoid user enumeration)', () => {
    expect(mapCognitoError({ name: 'UserNotFoundException' })).toBe(
      'Email o password non corretti',
    );
  });

  it('maps PasswordResetRequiredException', () => {
    expect(mapCognitoError({ name: 'PasswordResetRequiredException' })).toBe(
      'Devi reimpostare la password. Contatta il supporto.',
    );
  });

  it('maps UserNotConfirmedException', () => {
    expect(mapCognitoError({ name: 'UserNotConfirmedException' })).toBe(
      'Account non ancora attivato. Controlla la tua email.',
    );
  });

  it('maps LimitExceededException to throttling message', () => {
    expect(mapCognitoError({ name: 'LimitExceededException' })).toBe(
      'Troppi tentativi. Riprova tra qualche minuto.',
    );
  });

  it('maps TooManyRequestsException to the same throttling message', () => {
    expect(mapCognitoError({ name: 'TooManyRequestsException' })).toBe(
      'Troppi tentativi. Riprova tra qualche minuto.',
    );
  });

  it('falls back to a generic network error for unknown codes', () => {
    expect(mapCognitoError({ name: 'WeirdUnknownCode' })).toBe(
      'Impossibile contattare il server. Riprova.',
    );
  });

  it('falls back when the input is null', () => {
    expect(mapCognitoError(null)).toBe('Impossibile contattare il server. Riprova.');
  });

  it('falls back when the input is undefined', () => {
    expect(mapCognitoError(undefined)).toBe('Impossibile contattare il server. Riprova.');
  });

  it('falls back for an empty object', () => {
    expect(mapCognitoError({})).toBe('Impossibile contattare il server. Riprova.');
  });

  it('falls back when name is not a string', () => {
    expect(mapCognitoError({ name: 42 })).toBe('Impossibile contattare il server. Riprova.');
  });
});
