import { TRANSFER_CODE_RE, validateTransferCode } from '@/lib/validators/transfer';

describe('TRANSFER_CODE_RE', () => {
  it('accepts a well-formed code', () => {
    expect(TRANSFER_CODE_RE.test('TR-ABCD-2345')).toBe(true);
  });
  it('rejects ambiguous glyphs excluded from the alphabet (0 1 I O Q S U)', () => {
    expect(TRANSFER_CODE_RE.test('TR-AB0D-2345')).toBe(false);
    expect(TRANSFER_CODE_RE.test('TR-ABID-2345')).toBe(false);
  });
  it('rejects the GO- garage code shape', () => {
    expect(TRANSFER_CODE_RE.test('GO-234-ABCD')).toBe(false);
  });
});

describe('validateTransferCode', () => {
  it('requires a code', () => {
    expect(validateTransferCode('')).toBe('Codice obbligatorio');
  });
  it('rejects a malformed code with the format hint', () => {
    expect(validateTransferCode('TR-XX')).toBe('Codice non valido. Formato: TR-XXXX-XXXX');
  });
  it('accepts a valid code', () => {
    expect(validateTransferCode('TR-ABCD-2345')).toBeUndefined();
  });
});
