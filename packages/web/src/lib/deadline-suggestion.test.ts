import { describe, expect, it } from 'vitest';
import type { InterventionType } from '@/queries/types';
import { deriveDeadlineSuggestion, formatDeadlineSuggestion } from './deadline-suggestion';

function makeType(overrides: Partial<InterventionType>): InterventionType {
  return {
    id: 'uuid-1',
    code: 'MECCANICO',
    nameIt: 'Tagliando',
    description: '',
    icon: 'wrench',
    suggestsDeadline: true,
    defaultDeadlineMonths: 12,
    defaultDeadlineKm: 15000,
    custom: false,
    ...overrides,
  };
}

describe('deriveDeadlineSuggestion', () => {
  it('returns null for a null type', () => {
    expect(deriveDeadlineSuggestion(null)).toBeNull();
  });

  it('returns null when the type does not suggest a deadline', () => {
    expect(deriveDeadlineSuggestion(makeType({ suggestsDeadline: false }))).toBeNull();
  });

  it('returns null when it suggests but both defaults are null', () => {
    expect(
      deriveDeadlineSuggestion(makeType({ defaultDeadlineMonths: null, defaultDeadlineKm: null })),
    ).toBeNull();
  });

  it('returns the suggestion when both defaults are present', () => {
    expect(deriveDeadlineSuggestion(makeType({}))).toEqual({
      typeName: 'Tagliando',
      months: 12,
      km: 15000,
    });
  });

  it('returns months-only when km default is null', () => {
    expect(deriveDeadlineSuggestion(makeType({ defaultDeadlineKm: null }))).toEqual({
      typeName: 'Tagliando',
      months: 12,
      km: null,
    });
  });

  it('returns km-only when months default is null', () => {
    expect(deriveDeadlineSuggestion(makeType({ defaultDeadlineMonths: null }))).toEqual({
      typeName: 'Tagliando',
      months: null,
      km: 15000,
    });
  });
});

describe('formatDeadlineSuggestion', () => {
  it('formats both km and months with it-IT thousands separator', () => {
    expect(formatDeadlineSuggestion({ typeName: 'Tagliando', months: 12, km: 15000 })).toBe(
      'Suggerito per «Tagliando»: prossima scadenza tra 15.000 km o 12 mesi.',
    );
  });

  it('formats km only', () => {
    expect(formatDeadlineSuggestion({ typeName: 'Gomme', months: null, km: 40000 })).toBe(
      'Suggerito per «Gomme»: prossima scadenza tra 40.000 km.',
    );
  });

  it('formats months only', () => {
    expect(formatDeadlineSuggestion({ typeName: 'Revisione', months: 24, km: null })).toBe(
      'Suggerito per «Revisione»: prossima scadenza tra 24 mesi.',
    );
  });

  it('uses singular "mese" for 1 month', () => {
    expect(formatDeadlineSuggestion({ typeName: 'X', months: 1, km: null })).toBe(
      'Suggerito per «X»: prossima scadenza tra 1 mese.',
    );
  });

  it('includes 0 km as a valid km value', () => {
    expect(formatDeadlineSuggestion({ typeName: 'X', months: null, km: 0 })).toBe(
      'Suggerito per «X»: prossima scadenza tra 0 km.',
    );
  });
});
