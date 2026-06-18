import { describe, expect, it } from 'vitest';

import { selectionToTenantIds, toggleOfficinaSelection } from './officinaFilter';

const ALL = ['a', 'b', 'c'];

describe('toggleOfficinaSelection', () => {
  it('from "all" (empty), unchecking one yields the complement subset', () => {
    const next = toggleOfficinaSelection(new Set(), ALL, 'a');
    expect([...next].sort()).toEqual(['b', 'c']);
  });

  it('re-checking the last missing officina collapses back to "all" (empty)', () => {
    const next = toggleOfficinaSelection(new Set(['b', 'c']), ALL, 'a');
    expect(next.size).toBe(0);
  });

  it('unchecking the LAST remaining officina is a no-op (never shows none)', () => {
    const prev = new Set(['b']);
    const next = toggleOfficinaSelection(prev, ALL, 'b');
    // Bug guard: the action must NOT invert into "all". Selection is unchanged.
    expect(next).toBe(prev);
  });

  it('checking an additional officina from a subset extends the subset', () => {
    const next = toggleOfficinaSelection(new Set(['a']), ALL, 'b');
    expect([...next].sort()).toEqual(['a', 'b']);
  });
});

describe('selectionToTenantIds', () => {
  it('empty selection ⇒ [] (no server-side filter = all)', () => {
    expect(selectionToTenantIds(new Set())).toEqual([]);
  });

  it('subset selection ⇒ the explicit ids', () => {
    expect(selectionToTenantIds(new Set(['a', 'b'])).sort()).toEqual(['a', 'b']);
  });
});
