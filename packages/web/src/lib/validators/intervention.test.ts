import { describe, expect, it } from 'vitest';
import { CreateInterventionFormSchema, transformToPayload } from './intervention';

describe('CreateInterventionFormSchema', () => {
  it('accepts minimal valid form input', () => {
    const result = CreateInterventionFormSchema.parse({
      interventionTypeId: '11111111-1111-4111-8111-111111111111',
      interventionDate: '2026-05-06',
      odometerKm: 50000,
      description: 'Tagliando ordinario',
      partsReplaced: [],
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
    });
    expect(r.success).toBe(false);
  });
});

describe('transformToPayload', () => {
  const base = {
    interventionTypeId: '11111111-1111-4111-8111-111111111111',
    interventionDate: '2026-05-06',
    odometerKm: 50000,
    description: 'desc',
    partsReplaced: [],
  };

  it('omits empty title and internalNotes', () => {
    const out = transformToPayload({ ...base, title: '', internalNotes: '' });
    expect('title' in out).toBe(false);
    expect('internalNotes' in out).toBe(false);
  });

  it('includes title when non-empty', () => {
    const out = transformToPayload({ ...base, title: 'Tagliando 60k' });
    expect(out.title).toBe('Tagliando 60k');
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
