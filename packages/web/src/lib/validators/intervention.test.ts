import { describe, expect, it } from 'vitest';
import { CreateInterventionFormSchema, transformToPayload } from './intervention';

const CHECKLIST_ITEM_ID = '22222222-2222-4222-8222-222222222222';

describe('CreateInterventionFormSchema', () => {
  it('accepts minimal valid form input', () => {
    const result = CreateInterventionFormSchema.parse({
      interventionTypeId: '11111111-1111-4111-8111-111111111111',
      interventionDate: '2026-05-06',
      odometerKm: 50000,
      description: 'Tagliando ordinario',
      partsReplaced: [],
      checklistItemIds: [CHECKLIST_ITEM_ID],
    });
    expect(result.interventionTypeId).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('rejects empty description', () => {
    const r = CreateInterventionFormSchema.safeParse({
      interventionTypeId: '11111111-1111-4111-8111-111111111111',
      interventionDate: '2026-05-06',
      odometerKm: 50000,
      description: '',
      partsReplaced: [],
      checklistItemIds: [CHECKLIST_ITEM_ID],
    });
    expect(r.success).toBe(false);
  });

  it('rejects invalid date format', () => {
    const r = CreateInterventionFormSchema.safeParse({
      interventionTypeId: '11111111-1111-4111-8111-111111111111',
      interventionDate: '06/05/2026',
      odometerKm: 50000,
      description: 'x',
      partsReplaced: [],
      checklistItemIds: [CHECKLIST_ITEM_ID],
    });
    expect(r.success).toBe(false);
  });

  it('rejects negative km', () => {
    const r = CreateInterventionFormSchema.safeParse({
      interventionTypeId: '11111111-1111-4111-8111-111111111111',
      interventionDate: '2026-05-06',
      odometerKm: -1,
      description: 'x',
      partsReplaced: [],
      checklistItemIds: [CHECKLIST_ITEM_ID],
    });
    expect(r.success).toBe(false);
  });

  // BR-300 — at least one checklist item must be selected on create.
  it('rejects an empty checklistItemIds array with the BR-300 message', () => {
    const r = CreateInterventionFormSchema.safeParse({
      interventionTypeId: '11111111-1111-4111-8111-111111111111',
      interventionDate: '2026-05-06',
      odometerKm: 50000,
      description: 'x',
      partsReplaced: [],
      checklistItemIds: [],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.message).toBe('Seleziona almeno una voce checklist.');
    }
  });

  it('rejects a missing checklistItemIds field', () => {
    const r = CreateInterventionFormSchema.safeParse({
      interventionTypeId: '11111111-1111-4111-8111-111111111111',
      interventionDate: '2026-05-06',
      odometerKm: 50000,
      description: 'x',
      partsReplaced: [],
    });
    expect(r.success).toBe(false);
  });

  it('accepts a valid checklistItemIds array', () => {
    const r = CreateInterventionFormSchema.safeParse({
      interventionTypeId: '11111111-1111-4111-8111-111111111111',
      interventionDate: '2026-05-06',
      odometerKm: 50000,
      description: 'x',
      partsReplaced: [],
      checklistItemIds: [CHECKLIST_ITEM_ID],
    });
    expect(r.success).toBe(true);
  });
});

describe('transformToPayload', () => {
  const base = {
    interventionTypeId: '11111111-1111-4111-8111-111111111111',
    interventionDate: '2026-05-06',
    odometerKm: 50000,
    description: 'desc',
    partsReplaced: [],
    checklistItemIds: [CHECKLIST_ITEM_ID],
  };

  it('omits empty internalNotes', () => {
    const out = transformToPayload({ ...base, internalNotes: '' });
    expect('internalNotes' in out).toBe(false);
  });

  it('includes checklistItemIds in the payload', () => {
    const out = transformToPayload(base);
    expect(out.checklistItemIds).toEqual([CHECKLIST_ITEM_ID]);
  });

  it('omits createDeadline when enabled=false', () => {
    const out = transformToPayload({
      ...base,
      createDeadline: { enabled: false, monthsFromNow: 12 },
    });
    expect('createDeadline' in out).toBe(false);
  });

  it('includes createDeadline when enabled=true', () => {
    const out = transformToPayload({
      ...base,
      createDeadline: { enabled: true, monthsFromNow: 12, kmIncrement: 15000 },
    });
    expect(out.createDeadline).toEqual({ enabled: true, monthsFromNow: 12, kmIncrement: 15000 });
  });

  it('does NOT add forceKmDecrease (handled by mutation flow)', () => {
    const out = transformToPayload(base);
    expect('forceKmDecrease' in out).toBe(false);
  });
});
