export type SearchType = 'vin' | 'plate' | 'garage_code';

export type ParsedSearch = { kind: 'valid'; type: SearchType; value: string } | { kind: 'invalid' };

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;
const GARAGE_CODE_RE = /^GO-[A-Z0-9]{3}-[A-Z0-9]{4,5}$/;
const PLATE_RE = /^[A-Z0-9-]{5,10}$/;

export function parseSearchInput(raw: string): ParsedSearch {
  const v = raw.trim().toUpperCase();
  if (v.length === 0) return { kind: 'invalid' };
  if (VIN_RE.test(v)) return { kind: 'valid', type: 'vin', value: v };
  if (GARAGE_CODE_RE.test(v)) return { kind: 'valid', type: 'garage_code', value: v };
  if (PLATE_RE.test(v)) return { kind: 'valid', type: 'plate', value: v };
  return { kind: 'invalid' };
}
