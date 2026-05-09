import { describe, expect, it } from 'vitest';

import { decodeCursor, encodeCursor } from '../../../src/lib/cursor.js';

describe('cursor helpers', () => {
  it('round-trips a uuid through encode/decode', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const cursor = encodeCursor(id);
    expect(decodeCursor(cursor)).toBe(id);
  });

  it('returns undefined when the cursor is undefined', () => {
    expect(decodeCursor(undefined)).toBeUndefined();
  });

  it('returns undefined when the cursor is not valid base64url JSON', () => {
    expect(decodeCursor('not-a-cursor')).toBeUndefined();
  });

  it('returns undefined when the decoded payload has no id field', () => {
    const cursor = Buffer.from(JSON.stringify({ foo: 'bar' }), 'utf8').toString('base64url');
    expect(decodeCursor(cursor)).toBeUndefined();
  });

  it('returns undefined when the decoded payload id is not a string', () => {
    const cursor = Buffer.from(JSON.stringify({ id: 42 }), 'utf8').toString('base64url');
    expect(decodeCursor(cursor)).toBeUndefined();
  });
});
