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
});
