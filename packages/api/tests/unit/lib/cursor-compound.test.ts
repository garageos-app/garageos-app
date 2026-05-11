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

  it('does NOT validate semantic field content (helper is value-agnostic — callers must guard)', () => {
    // The helper only checks that the field is a string. Callers that
    // feed cursor.ra into `new Date(...)` must additionally guard against
    // non-date string content (`!Number.isNaN(new Date(value).getTime())`)
    // so a hand-crafted cursor like {"ra":"banana","id":"uuid"} returns
    // a clean page-1 result instead of throwing RangeError downstream.
    // See interventions-revisions-list.ts and vehicles-timeline.ts for
    // the call-site guard pattern.
    const hostile = Buffer.from(
      JSON.stringify({ ra: 'banana', id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }),
      'utf8',
    ).toString('base64url');
    const decoded = decodeCompoundCursor('ra', hostile);
    expect(decoded).toEqual({
      ra: 'banana',
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    });
    // ...and the corresponding caller-side guard would reject it:
    expect(Number.isNaN(new Date(decoded!.ra).getTime())).toBe(true);
  });
});
