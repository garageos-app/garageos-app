import { describe, expect, it } from 'vitest';

import {
  decodeCompoundCursor,
  decodeDateCompoundCursor,
  encodeCompoundCursor,
} from '../../../src/lib/cursor.js';

describe('cursor compound helpers', () => {
  it('round-trips a single field+id pair', () => {
    const cursor = encodeCompoundCursor('ra', '2026-04-05T14:00:00.000Z', 'abc-uuid');
    const decoded = decodeCompoundCursor('ra', cursor);
    expect(decoded).toEqual({ ra: '2026-04-05T14:00:00.000Z', id: 'abc-uuid' });
  });

  it('round-trips with a different field name', () => {
    const cursor = encodeCompoundCursor('d', '2026-04-05', 'xyz-uuid');
    const decoded = decodeCompoundCursor('d', cursor);
    expect(decoded).toEqual({ d: '2026-04-05', id: 'xyz-uuid' });
  });

  it('returns undefined when cursor is undefined', () => {
    expect(decodeCompoundCursor('ra', undefined)).toBeUndefined();
  });

  it('returns undefined when cursor is malformed base64', () => {
    expect(decodeCompoundCursor('ra', 'not-base64!!!')).toBeUndefined();
  });

  it('returns undefined when decoded JSON lacks the expected field', () => {
    const cursor = encodeCompoundCursor('ra', '2026-04-05', 'abc');
    expect(decodeCompoundCursor('d', cursor)).toBeUndefined();
  });

  it('returns undefined when decoded id is not a string', () => {
    const malformed = Buffer.from(JSON.stringify({ ra: '2026', id: 123 }), 'utf8').toString(
      'base64url',
    );
    expect(decodeCompoundCursor('ra', malformed)).toBeUndefined();
  });

  it('does NOT validate semantic field content (helper is value-agnostic — callers must use decodeDateCompoundCursor)', () => {
    // decodeCompoundCursor only checks that the field is a string; it
    // passes 'banana' through. Callers that feed cursor.ra into
    // `new Date(...)` must use decodeDateCompoundCursor (below) instead.
    const hostile = Buffer.from(
      JSON.stringify({ ra: 'banana', id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }),
      'utf8',
    ).toString('base64url');
    const decoded = decodeCompoundCursor('ra', hostile);
    expect(decoded).toEqual({
      ra: 'banana',
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    });
  });
});

describe('decodeDateCompoundCursor', () => {
  it('accepts a valid ISO timestamp (format=timestamp)', () => {
    const cursor = encodeCompoundCursor('ra', '2026-04-05T14:00:00.000Z', 'uuid-1');
    const decoded = decodeDateCompoundCursor('ra', cursor, 'timestamp');
    expect(decoded).toEqual({ ra: '2026-04-05T14:00:00.000Z', id: 'uuid-1' });
  });

  it('accepts a valid date-only YYYY-MM-DD (format=date)', () => {
    const cursor = encodeCompoundCursor('d', '2026-04-05', 'uuid-2');
    const decoded = decodeDateCompoundCursor('d', cursor, 'date');
    expect(decoded).toEqual({ d: '2026-04-05', id: 'uuid-2' });
  });

  it('returns undefined when field value is a non-date string (timestamp format)', () => {
    const hostile = Buffer.from(JSON.stringify({ ra: 'banana', id: 'uuid-3' }), 'utf8').toString(
      'base64url',
    );
    expect(decodeDateCompoundCursor('ra', hostile, 'timestamp')).toBeUndefined();
  });

  it('returns undefined when field value is a non-date string (date format)', () => {
    const hostile = Buffer.from(JSON.stringify({ d: 'banana', id: 'uuid-4' }), 'utf8').toString(
      'base64url',
    );
    expect(decodeDateCompoundCursor('d', hostile, 'date')).toBeUndefined();
  });

  it('returns undefined when cursor itself is undefined', () => {
    expect(decodeDateCompoundCursor('ra', undefined, 'timestamp')).toBeUndefined();
  });

  it('returns undefined when cursor is malformed base64', () => {
    expect(decodeDateCompoundCursor('ra', 'not-base64!!!', 'timestamp')).toBeUndefined();
  });

  it('returns undefined when field is missing from decoded JSON', () => {
    const cursor = encodeCompoundCursor('ra', '2026-04-05T14:00:00.000Z', 'uuid');
    expect(decodeDateCompoundCursor('d', cursor, 'date')).toBeUndefined();
  });
});
