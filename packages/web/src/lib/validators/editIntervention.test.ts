import { describe, expect, it } from 'vitest';
import { EditInterventionFormSchema } from './editIntervention';

describe('EditInterventionFormSchema', () => {
  it('accepts an empty object (every field optional)', () => {
    expect(EditInterventionFormSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a fully populated form payload', () => {
    const result = EditInterventionFormSchema.safeParse({
      interventionTypeId: '11111111-1111-4111-8111-111111111111',
      title: 'Tagliando',
      description: 'Olio + filtri',
      partsReplaced: [{ name: 'Olio motore', quantity: 1, unit: 'L' }],
      internalNotes: 'Cliente segnala rumore',
      reason: 'Aggiunta nota interna su rumore',
    });
    expect(result.success).toBe(true);
  });

  it('rejects title longer than 200 chars', () => {
    const result = EditInterventionFormSchema.safeParse({
      title: 'x'.repeat(201),
    });
    expect(result.success).toBe(false);
  });

  it('rejects description with zero characters when provided', () => {
    const result = EditInterventionFormSchema.safeParse({
      description: '',
    });
    expect(result.success).toBe(false);
  });

  it('accepts null for nullable optional fields (title, internalNotes)', () => {
    expect(EditInterventionFormSchema.safeParse({ title: null, internalNotes: null }).success).toBe(
      true,
    );
  });

  it('rejects reason longer than 2000 chars', () => {
    const result = EditInterventionFormSchema.safeParse({
      reason: 'x'.repeat(2001),
    });
    expect(result.success).toBe(false);
  });
});
