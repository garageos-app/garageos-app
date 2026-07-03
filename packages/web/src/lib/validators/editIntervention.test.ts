import { describe, expect, it } from 'vitest';
import { EditInterventionFormSchema } from './editIntervention';

const CHECKLIST_ITEM_ID = '22222222-2222-4222-8222-222222222222';

describe('EditInterventionFormSchema', () => {
  it('accepts an empty object (every field optional)', () => {
    expect(EditInterventionFormSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a fully populated form payload', () => {
    const result = EditInterventionFormSchema.safeParse({
      interventionTypeId: '11111111-1111-4111-8111-111111111111',
      description: 'Olio + filtri',
      partsReplaced: [{ name: 'Olio motore', quantity: 1, unit: 'L' }],
      internalNotes: 'Cliente segnala rumore',
      reason: 'Aggiunta nota interna su rumore',
      checklistItemIds: [CHECKLIST_ITEM_ID],
    });
    expect(result.success).toBe(true);
  });

  it('rejects description with zero characters when provided', () => {
    const result = EditInterventionFormSchema.safeParse({
      description: '',
    });
    expect(result.success).toBe(false);
  });

  it('accepts null for the nullable optional internalNotes field', () => {
    expect(EditInterventionFormSchema.safeParse({ internalNotes: null }).success).toBe(true);
  });

  it('rejects reason longer than 2000 chars', () => {
    const result = EditInterventionFormSchema.safeParse({
      reason: 'x'.repeat(2001),
    });
    expect(result.success).toBe(false);
  });

  // checklistItemIds: undefined = unchanged, array = replace-set (BR-303/BR-308).
  it('accepts checklistItemIds omitted (undefined = unchanged)', () => {
    const result = EditInterventionFormSchema.safeParse({
      description: 'Olio + filtri',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid checklistItemIds array (replace-set)', () => {
    const result = EditInterventionFormSchema.safeParse({
      checklistItemIds: [CHECKLIST_ITEM_ID],
    });
    expect(result.success).toBe(true);
  });

  it('rejects checklistItemIds containing a non-uuid value', () => {
    const result = EditInterventionFormSchema.safeParse({
      checklistItemIds: ['not-a-uuid'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects null for checklistItemIds (only undefined or an array are valid, not null)', () => {
    const result = EditInterventionFormSchema.safeParse({
      checklistItemIds: null,
    });
    expect(result.success).toBe(false);
  });
});
