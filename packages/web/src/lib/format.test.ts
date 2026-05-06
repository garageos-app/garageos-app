import { describe, expect, it } from 'vitest';
import { fallback, formatCurrency, formatDate, formatKm } from './format';

describe('format.ts — Italian locale wrappers', () => {
  it('formatDate: ISO string → dd/MM/yyyy', () => {
    expect(formatDate('2026-04-15T10:30:00Z')).toBe('15/04/2026');
  });

  it('formatDate: null → em-dash', () => {
    expect(formatDate(null)).toBe('—');
  });

  it('formatKm: integer → thousands separator (it-IT) + " km"', () => {
    expect(formatKm(145230)).toBe('145.230 km');
  });

  it('formatKm: null → em-dash', () => {
    expect(formatKm(null)).toBe('—');
  });

  it('formatCurrency: cents → "€ NN,NN" (it-IT)', () => {
    expect(formatCurrency(38000)).toMatch(/^380,00\s?€$|^€\s?380,00$/);
  });

  it('fallback: nullish → em-dash, value passthrough', () => {
    expect(fallback(null)).toBe('—');
    expect(fallback(undefined)).toBe('—');
    expect(fallback('Mario')).toBe('Mario');
  });
});
