import { describe, expect, it } from 'vitest';
import { parseSearchInput } from './search-input';

describe('parseSearchInput', () => {
  it('VIN: 17 alfanum ISO 3779 (no I/O/Q) → vin', () => {
    expect(parseSearchInput('ZFA31200000123456')).toEqual({
      kind: 'valid',
      type: 'vin',
      value: 'ZFA31200000123456',
    });
  });

  it('VIN: 16 char → invalid (troppo corto)', () => {
    expect(parseSearchInput('ZFA3120000012345')).toEqual({ kind: 'invalid' });
  });

  it('VIN: 17 char con "I" → invalid (carattere proibito ISO 3779)', () => {
    expect(parseSearchInput('ZFI31200000123456')).toEqual({ kind: 'invalid' });
  });

  it('garage_code: GO-XXX-XXXX uppercase → garage_code', () => {
    expect(parseSearchInput('GO-482-KXRT')).toEqual({
      kind: 'valid',
      type: 'garage_code',
      value: 'GO-482-KXRT',
    });
  });

  it('garage_code: lowercase → normalized uppercase', () => {
    expect(parseSearchInput('go-482-kxrt')).toEqual({
      kind: 'valid',
      type: 'garage_code',
      value: 'GO-482-KXRT',
    });
  });

  it('garage_code: senza prefisso GO- → fallback plate', () => {
    expect(parseSearchInput('482-KXRT')).toEqual({
      kind: 'valid',
      type: 'plate',
      value: '482-KXRT',
    });
  });

  it('plate IT: AB123CD → plate', () => {
    expect(parseSearchInput('AB123CD')).toEqual({
      kind: 'valid',
      type: 'plate',
      value: 'AB123CD',
    });
  });

  it('plate ES: 1234ABC → plate', () => {
    expect(parseSearchInput('1234ABC')).toEqual({
      kind: 'valid',
      type: 'plate',
      value: '1234ABC',
    });
  });

  it('plate troppo corta: AB12 → invalid', () => {
    expect(parseSearchInput('AB12')).toEqual({ kind: 'invalid' });
  });

  it('plate troppo lunga: 11 char → invalid', () => {
    expect(parseSearchInput('ABCDEFGHIJK')).toEqual({ kind: 'invalid' });
  });

  it('whitespace: trim e uppercase', () => {
    expect(parseSearchInput('  ab123cd  ')).toEqual({
      kind: 'valid',
      type: 'plate',
      value: 'AB123CD',
    });
  });

  it('empty: invalid', () => {
    expect(parseSearchInput('')).toEqual({ kind: 'invalid' });
    expect(parseSearchInput('   ')).toEqual({ kind: 'invalid' });
  });
});
