import { describe, expect, it } from 'vitest';

import { resolveLocationFilter } from '../../../src/lib/location-filter.js';

const LOC_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LOC_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('resolveLocationFilter (BR-205)', () => {
  it('mechanic is forced to own location; query param is ignored', () => {
    expect(resolveLocationFilter('mechanic', LOC_A, LOC_B)).toBe(LOC_A);
  });

  it('mechanic uses own location when no query param given', () => {
    expect(resolveLocationFilter('mechanic', LOC_A, undefined)).toBe(LOC_A);
  });

  it('mechanic without a location yields no filter (defensive; BR-204 prevents this)', () => {
    expect(resolveLocationFilter('mechanic', undefined, LOC_B)).toBeUndefined();
  });

  it('super_admin applies the query param when present', () => {
    expect(resolveLocationFilter('super_admin', undefined, LOC_B)).toBe(LOC_B);
  });

  it('super_admin sees all sedi (undefined) when no query param', () => {
    expect(resolveLocationFilter('super_admin', undefined, undefined)).toBeUndefined();
  });

  it('super_admin ignores its own location attribute (sees all unless narrowed)', () => {
    expect(resolveLocationFilter('super_admin', LOC_A, undefined)).toBeUndefined();
  });
});
