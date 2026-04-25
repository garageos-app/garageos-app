// ISO 3779 check-digit validator. The 9th character of a 17-char VIN is
// the check digit, computed from a weighted sum of transliterated values
// of the other 16 positions, modulo 11. The letter X represents the
// residue 10. Pre-1981 and special-use vehicles (agricultural, military)
// commonly violate the checksum — callers pass `forceNonstandardVin=true`
// via the request schema to bypass this check while still enforcing the
// 17-character alphanumeric shape from VinSchema.

const TRANSLIT: Record<string, number> = {
  A: 1,
  B: 2,
  C: 3,
  D: 4,
  E: 5,
  F: 6,
  G: 7,
  H: 8,
  J: 1,
  K: 2,
  L: 3,
  M: 4,
  N: 5,
  P: 7,
  R: 9,
  S: 2,
  T: 3,
  U: 4,
  V: 5,
  W: 6,
  X: 7,
  Y: 8,
  Z: 9,
  '0': 0,
  '1': 1,
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 7,
  '8': 8,
  '9': 9,
};

const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

const VIN_ALPHABET = /^[A-HJ-NPR-Z0-9]{17}$/;

export function validateVinIso3779(vin: string): boolean {
  if (!VIN_ALPHABET.test(vin)) return false;

  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const ch = vin[i]!;
    const value = TRANSLIT[ch];
    if (value === undefined) return false;
    sum += value * WEIGHTS[i]!;
  }

  const remainder = sum % 11;
  const expected = remainder === 10 ? 'X' : String(remainder);
  return vin[8] === expected;
}
