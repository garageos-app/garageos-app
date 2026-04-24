import { describe, expect, it } from 'vitest';

import {
  EmailSchema,
  GarageCodeSchema,
  IsoDateSchema,
  ItalianPlateSchema,
  PaginationSchema,
  PhoneSchema,
  TaxCodeSchema,
  UuidSchema,
  VatNumberSchema,
  VinSchema,
} from '../../../src/validators/common.js';

describe('BR-020 — GarageCode format', () => {
  it.each(['GO-482-KXRT', 'GO-234-ABCD', 'GO-999-ZZZZ', 'GO-222-HJKL'])(
    'accepts valid code: %s',
    (code) => {
      expect(GarageCodeSchema.parse(code)).toBe(code);
    },
  );

  it.each([
    ['GO-012-KXRT', 'contiene 0 e 1'],
    ['GO-482-KXRI', 'contiene I'],
    ['GO-482-KXRO', 'contiene O'],
    ['GO-482-KXRQ', 'contiene Q'],
    ['GO-482-KXRU', 'contiene U'],
    ['XX-482-KXRT', 'prefisso errato'],
    ['GO-48-KXRT', 'poche cifre'],
    ['GO-4828-KXRT', 'troppe cifre'],
    ['GO-482-KXR', 'poche lettere'],
    ['GO-482-KXRTE', 'troppe lettere'],
    ['go-482-kxrt', 'lowercase — validatore non normalizza'],
    ['GO-482-KX1T', 'numeri nella parte lettere'],
    ['', 'stringa vuota'],
  ])('rejects %s (%s)', (code) => {
    expect(() => GarageCodeSchema.parse(code)).toThrow();
  });
});

describe('BR-001 — VIN format', () => {
  it.each(['ZFA16900000512345', 'WVWZZZ1JZXW123456', 'ABCDEFGH1234567JK'])(
    'accepts valid VIN: %s',
    (vin) => {
      expect(VinSchema.parse(vin)).toBe(vin);
    },
  );

  it.each([
    ['ZFA1690000051234', '16 chars (short)'],
    ['ZFA169000005123456', '18 chars (long)'],
    ['ZFA1690000051234I', 'contains I'],
    ['ZFA1690000051234O', 'contains O'],
    ['ZFA1690000051234Q', 'contains Q'],
    ['ZFA16900000-12345', 'contains hyphen'],
    ['zfa16900000512345', 'lowercase'],
    ['', 'empty'],
  ])('rejects VIN %s (%s)', (vin) => {
    expect(() => VinSchema.parse(vin)).toThrow();
  });
});

describe('ItalianPlate format', () => {
  it.each(['AB123CD', 'ZZ999XX', 'AA000BB'])('accepts valid plate: %s', (plate) => {
    expect(ItalianPlateSchema.parse(plate)).toBe(plate);
  });

  it.each([
    ['ab123cd', 'lowercase'],
    ['A1123CD', 'digit in first letter pair'],
    ['AB12CD', 'missing digit'],
    ['AB1234CD', 'extra digit'],
    ['AB-123-CD', 'with hyphens'],
    ['', 'empty'],
  ])('rejects plate %s (%s)', (plate) => {
    expect(() => ItalianPlateSchema.parse(plate)).toThrow();
  });
});

describe('Email format (Zod 4 top-level z.email)', () => {
  it.each(['user@example.com', 'first.last+tag@sub.example.it', 'a@b.co'])(
    'accepts %s',
    (email) => {
      expect(EmailSchema.parse(email)).toBe(email);
    },
  );

  it.each(['plainstring', 'missing@', '@missing.local', 'spaces in@it.com', ''])(
    'rejects %s',
    (email) => {
      expect(() => EmailSchema.parse(email)).toThrow();
    },
  );
});

describe('TaxCode (Italian) format', () => {
  it.each([
    'RSSMRA85M01H501Z', // individual CF
    '12345678901', // legal entity (11 digits)
  ])('accepts valid tax code: %s', (code) => {
    expect(TaxCodeSchema.parse(code)).toBe(code);
  });

  it.each([
    'rssmra85m01h501z', // lowercase
    '1234567890', // 10 digits
    '123456789012', // 12 digits
    'RSSMRA85M01H501', // 15 chars individual
    '',
  ])('rejects tax code %s', (code) => {
    expect(() => TaxCodeSchema.parse(code)).toThrow();
  });
});

describe('VatNumber (P.IVA) format', () => {
  it.each(['12345678901', '00000000001', '99999999999'])('accepts %s', (v) => {
    expect(VatNumberSchema.parse(v)).toBe(v);
  });

  it.each([
    '1234567890', // 10 digits
    '123456789012', // 12 digits
    'ABCDEFGHIJK', // letters
    '',
  ])('rejects %s', (v) => {
    expect(() => VatNumberSchema.parse(v)).toThrow();
  });
});

describe('Phone format', () => {
  it('accepts a 10-char phone', () => {
    expect(PhoneSchema.parse('+39 333 12')).toBe('+39 333 12');
  });

  it('rejects strings shorter than 6 chars', () => {
    expect(() => PhoneSchema.parse('12345')).toThrow();
  });

  it('rejects strings longer than 30 chars', () => {
    expect(() => PhoneSchema.parse('1'.repeat(31))).toThrow();
  });
});

describe('UUID format (Zod 4 strict RFC 4122)', () => {
  it('accepts a crypto.randomUUID() value', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    expect(UuidSchema.parse(id)).toBe(id);
  });

  it.each([
    ['', 'empty'],
    ['not-a-uuid', 'plain string'],
    ['550e8400-e29b-41d4-a716', 'truncated'],
    ['550e8400e29b41d4a716446655440000', 'missing hyphens'],
  ])('rejects %s (%s)', (v) => {
    expect(() => UuidSchema.parse(v)).toThrow();
  });
});

describe('IsoDate format (YYYY-MM-DD)', () => {
  it.each(['2026-04-24', '1900-01-01', '2099-12-31'])('accepts %s', (d) => {
    expect(IsoDateSchema.parse(d)).toBe(d);
  });

  it.each(['2026-4-24', '24-04-2026', '2026/04/24', '2026-04-24T10:00:00Z', ''])(
    'rejects %s',
    (d) => {
      expect(() => IsoDateSchema.parse(d)).toThrow();
    },
  );
});

describe('PaginationSchema defaults & bounds', () => {
  it('defaults limit to 20 when omitted', () => {
    const parsed = PaginationSchema.parse({});
    expect(parsed.limit).toBe(20);
    expect(parsed.cursor).toBeUndefined();
  });

  it('accepts explicit limit within bounds', () => {
    expect(PaginationSchema.parse({ limit: 50 }).limit).toBe(50);
  });

  it('rejects non-positive limit', () => {
    expect(() => PaginationSchema.parse({ limit: 0 })).toThrow();
    expect(() => PaginationSchema.parse({ limit: -1 })).toThrow();
  });

  it('rejects limit above 100', () => {
    expect(() => PaginationSchema.parse({ limit: 101 })).toThrow();
  });
});
