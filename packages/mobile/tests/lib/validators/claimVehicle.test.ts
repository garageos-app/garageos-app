import { validateClaimForm } from '@/lib/validators/claimVehicle';

describe('validateClaimForm', () => {
  it('accepts a well-formed normalized code', () => {
    expect(validateClaimForm('GO-234-ABCD')).toBeUndefined();
  });

  it('requires a non-empty code', () => {
    expect(validateClaimForm('')).toBe('Codice obbligatorio');
  });

  it('rejects wrong overall format', () => {
    expect(validateClaimForm('ABC123')).toBe('Codice non valido. Formato: GO-NNN-AAAA');
  });

  it('rejects digits outside 2-9', () => {
    expect(validateClaimForm('GO-100-ABCD')).toBe('Codice non valido. Formato: GO-NNN-AAAA');
  });

  it('rejects forbidden letters I/O/Q/S/U', () => {
    expect(validateClaimForm('GO-234-ABIO')).toBe('Codice non valido. Formato: GO-NNN-AAAA');
  });

  it('is case-sensitive on the normalized input (lowercase already invalid)', () => {
    // The form normalizes to uppercase before calling; a lowercase code here
    // means un-normalized input, which must fail.
    expect(validateClaimForm('go-234-abcd')).toBe('Codice non valido. Formato: GO-NNN-AAAA');
  });
});
