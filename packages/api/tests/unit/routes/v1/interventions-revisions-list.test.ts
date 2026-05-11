import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { decodeCompoundCursor, encodeCompoundCursor } from '../../../../src/lib/cursor.js';
import {
  filterRevisionsForCustomer,
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

describe('encodeCompoundCursor / decodeCompoundCursor (ra field)', () => {
  it('roundtrips a valid cursor', () => {
    const ra = '2026-04-27T10:15:00.000Z';
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const decoded = decodeCompoundCursor('ra', encodeCompoundCursor('ra', ra, id));
    expect(decoded).toEqual({ ra, id });
  });

  it('decodes invalid base64 → undefined', () => {
    expect(decodeCompoundCursor('ra', '!!!!')).toBeUndefined();
  });

  it('decodes JSON missing ra → undefined', () => {
    const bogus = Buffer.from(JSON.stringify({ id: 'x' }), 'utf8').toString('base64url');
    expect(decodeCompoundCursor('ra', bogus)).toBeUndefined();
  });

  it('decodes JSON missing id → undefined', () => {
    const bogus = Buffer.from(JSON.stringify({ ra: '2026-04-27T10:00:00Z' }), 'utf8').toString(
      'base64url',
    );
    expect(decodeCompoundCursor('ra', bogus)).toBeUndefined();
  });

  it('decodes undefined input → undefined', () => {
    expect(decodeCompoundCursor('ra', undefined)).toBeUndefined();
  });
});

describe('filterRevisionsForCustomer', () => {
  function makeRow(changes: unknown) {
    return {
      id: 'row-1',
      revisedAt: new Date('2026-04-27T10:00:00Z'),
      reason: 'r',
      changes,
    };
  }

  it('strips internalNotes but preserves other fields', () => {
    const row = makeRow({
      title: { from: 'A', to: 'B' },
      internalNotes: { from: 'X', to: 'Y' },
    });
    const out = filterRevisionsForCustomer([row]);
    expect(out).toHaveLength(1);
    expect(out[0]!.changes).toEqual({ title: { from: 'A', to: 'B' } });
  });

  it('drops a row whose only change was internalNotes', () => {
    const row = makeRow({ internalNotes: { from: 'X', to: 'Y' } });
    const out = filterRevisionsForCustomer([row]);
    expect(out).toHaveLength(0);
  });

  it('drops a row with non-object changes (defensive)', () => {
    const row = makeRow('not-an-object');
    const out = filterRevisionsForCustomer([row]);
    expect(out).toHaveLength(0);
  });

  it('drops a row with null changes', () => {
    const row = makeRow(null);
    const out = filterRevisionsForCustomer([row]);
    expect(out).toHaveLength(0);
  });

  it('drops a row with array changes (defensive)', () => {
    const row = makeRow([{ title: 'x' }]);
    const out = filterRevisionsForCustomer([row]);
    expect(out).toHaveLength(0);
  });

  it('preserves order of input rows', () => {
    const a = { ...makeRow({ title: { from: 'A1', to: 'A2' } }), id: 'a' };
    const b = { ...makeRow({ description: { from: 'B1', to: 'B2' } }), id: 'b' };
    const c = { ...makeRow({ title: { from: 'C1', to: 'C2' } }), id: 'c' };
    const out = filterRevisionsForCustomer([a, b, c]);
    expect(out.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('skips multiple internalNotes-only rows in a sequence', () => {
    const a = { ...makeRow({ internalNotes: { from: 'X', to: 'Y' } }), id: 'a' };
    const b = { ...makeRow({ title: { from: 'B1', to: 'B2' } }), id: 'b' };
    const c = { ...makeRow({ internalNotes: { from: 'P', to: 'Q' } }), id: 'c' };
    const out = filterRevisionsForCustomer([a, b, c]);
    expect(out.map((r) => r.id)).toEqual(['b']);
  });
});
