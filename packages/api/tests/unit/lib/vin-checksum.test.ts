import { describe, expect, it } from 'vitest';

import { validateVinIso3779 } from '../../../src/lib/vin-checksum.js';

// Reference VINs sourced from the ISO 3779 worked example:
//   https://en.wikipedia.org/wiki/Vehicle_identification_number#Check-digit_calculation
// 1M8GDM9AXKP042788 has a computed check digit of X ≡ 10 and matches
// position 9 = 'X', so it is valid under ISO 3779.

describe('validateVinIso3779', () => {
  it('accepts a VIN with a correct ISO 3779 check digit', () => {
    expect(validateVinIso3779('1M8GDM9AXKP042788')).toBe(true);
  });

  it('rejects a VIN where the check digit is wrong', () => {
    // Same VIN as above but position 9 flipped from X to 1.
    expect(validateVinIso3779('1M8GDM9A1KP042788')).toBe(false);
  });

  it('rejects VINs that are not 17 characters long', () => {
    expect(validateVinIso3779('1M8GDM9A')).toBe(false);
    expect(validateVinIso3779('1M8GDM9AXKP042788X')).toBe(false);
  });

  it('rejects VINs containing the banned characters I/O/Q', () => {
    expect(validateVinIso3779('IM8GDM9AXKP042788')).toBe(false);
    expect(validateVinIso3779('1M8GDM9AOKP042788')).toBe(false);
    expect(validateVinIso3779('1M8GDM9AXKP04278Q')).toBe(false);
  });

  it('treats lowercase input as lowercase (caller is expected to uppercase first)', () => {
    expect(validateVinIso3779('1m8gdm9axkp042788')).toBe(false);
  });
});
