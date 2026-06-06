import { extractGarageCode } from '@/lib/qr';

describe('extractGarageCode', () => {
  it('extracts the code from the tag URL', () => {
    expect(extractGarageCode('https://app.garageos.it/v/GO-482-KXRT')).toBe('GO-482-KXRT');
  });

  it('handles a trailing slash and a query string', () => {
    expect(extractGarageCode('https://app.garageos.it/v/GO-482-KXRT/')).toBe('GO-482-KXRT');
    expect(extractGarageCode('https://app.garageos.it/v/GO-482-KXRT?utm=tag')).toBe('GO-482-KXRT');
  });

  it('accepts a bare code', () => {
    expect(extractGarageCode('GO-482-KXRT')).toBe('GO-482-KXRT');
  });

  it('normalizes to uppercase', () => {
    expect(extractGarageCode('go-482-kxrt')).toBe('GO-482-KXRT');
    expect(extractGarageCode('  https://app.garageos.it/v/go-482-kxrt ')).toBe('GO-482-KXRT');
  });

  it('returns null for an unrelated URL or junk', () => {
    expect(extractGarageCode('https://example.com/promo')).toBeNull();
    expect(extractGarageCode('hello world')).toBeNull();
    expect(extractGarageCode('')).toBeNull();
  });

  it('returns null for codes failing BR-020 (forbidden digits/letters)', () => {
    expect(extractGarageCode('GO-100-ABCD')).toBeNull(); // digit 1 not allowed
    expect(extractGarageCode('GO-234-ABIO')).toBeNull(); // I/O not allowed
  });
});
