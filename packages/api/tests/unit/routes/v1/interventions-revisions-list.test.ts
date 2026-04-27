import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import {
  decodeCursor,
  encodeCursor,
  revisionsListQuerySchema,
} from '../../../../src/routes/v1/interventions-revisions-list.js';

describe('revisionsListQuerySchema', () => {
  it('applies default limit=20 when omitted', () => {
    const parsed = revisionsListQuerySchema.parse({});
    expect(parsed.limit).toBe(20);
    expect(parsed.cursor).toBeUndefined();
  });

  it('coerces limit string to int', () => {
    const parsed = revisionsListQuerySchema.parse({ limit: '15' });
    expect(parsed.limit).toBe(15);
  });

  it('rejects limit=0', () => {
    expect(() => revisionsListQuerySchema.parse({ limit: 0 })).toThrow();
  });

  it('rejects limit above max=50', () => {
    expect(() => revisionsListQuerySchema.parse({ limit: 51 })).toThrow();
  });

  it('rejects negative limit', () => {
    expect(() => revisionsListQuerySchema.parse({ limit: -1 })).toThrow();
  });

  it('accepts valid cursor string', () => {
    const parsed = revisionsListQuerySchema.parse({ cursor: 'eyJyYSI6IngifQ' });
    expect(parsed.cursor).toBe('eyJyYSI6IngifQ');
  });
});

describe('encodeCursor / decodeCursor', () => {
  it('roundtrips a valid cursor', () => {
    const c = { ra: '2026-04-27T10:15:00.000Z', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
    const decoded = decodeCursor(encodeCursor(c));
    expect(decoded).toEqual(c);
  });

  it('decodes invalid base64 → undefined', () => {
    expect(decodeCursor('!!!!')).toBeUndefined();
  });

  it('decodes JSON missing ra → undefined', () => {
    const bogus = Buffer.from(JSON.stringify({ id: 'x' }), 'utf8').toString('base64url');
    expect(decodeCursor(bogus)).toBeUndefined();
  });

  it('decodes JSON missing id → undefined', () => {
    const bogus = Buffer.from(JSON.stringify({ ra: '2026-04-27T10:00:00Z' }), 'utf8').toString(
      'base64url',
    );
    expect(decodeCursor(bogus)).toBeUndefined();
  });

  it('decodes JSON with non-ISO ra → undefined', () => {
    const bogus = Buffer.from(JSON.stringify({ ra: 'not-a-date', id: 'x' }), 'utf8').toString(
      'base64url',
    );
    expect(decodeCursor(bogus)).toBeUndefined();
  });

  it('decodes undefined input → undefined', () => {
    expect(decodeCursor(undefined)).toBeUndefined();
  });
});
