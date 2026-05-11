import { describe, expect, it } from 'vitest';

import { encodeCompoundCursor, decodeCompoundCursor } from '../../../src/lib/cursor.js';

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
});
