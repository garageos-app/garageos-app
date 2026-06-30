import { describe, expect, it } from 'vitest';
import { translateError, ERROR_MESSAGES } from './error-messages';

describe('vehicle.creation error strings', () => {
  it('maps duplicate VIN to an Italian message', () => {
    expect(translateError('vehicle.creation.duplicate_vin', 'x')).toMatch(/VIN/i);
  });
  it('falls back for unknown codes', () => {
    expect(translateError('vehicle.creation.unknown', 'fallback')).toBe('fallback');
  });
});

describe('translateError', () => {
  it('returns mapped message for known code', () => {
    expect(translateError('intervention.creation.date_future', 'fallback')).toBe(
      'Non è possibile registrare interventi futuri.',
    );
  });

  it('returns mapped message for vehicle.modification.archived', () => {
    expect(translateError('vehicle.modification.archived', 'fb')).toContain('archiviato');
  });

  it('falls back when code not in dictionary', () => {
    expect(translateError('unknown.code', 'fallback message')).toBe('fallback message');
  });

  it('contains expected keys', () => {
    expect(ERROR_MESSAGES['intervention.creation.date_before_registration']).toBeDefined();
    expect(ERROR_MESSAGES['NOT_FOUND']).toBeDefined();
    expect(ERROR_MESSAGES['VALIDATION_ERROR']).toBeDefined();
  });
});
