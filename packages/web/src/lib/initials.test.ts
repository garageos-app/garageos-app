import { describe, expect, it } from 'vitest';

import { getInitials } from './initials';

describe('getInitials', () => {
  it('returns first letter of firstName + first letter of lastName, uppercase', () => {
    expect(getInitials('mario', 'rossi')).toBe('MR');
  });

  it('handles already-uppercase input', () => {
    expect(getInitials('Mario', 'Rossi')).toBe('MR');
  });

  it('falls back to single letter when one name is empty', () => {
    expect(getInitials('Mario', '')).toBe('M');
    expect(getInitials('', 'Rossi')).toBe('R');
  });

  it('returns "?" when both empty', () => {
    expect(getInitials('', '')).toBe('?');
  });

  it('trims whitespace', () => {
    expect(getInitials('  Mario  ', ' Rossi ')).toBe('MR');
  });
});
