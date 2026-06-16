import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  CreatePersonalDeadlineSchema,
  PersonalDeadlineCategoryEnum,
  UpdatePersonalDeadlineSchema,
} from '../../../src/validators/personal-deadline.js';

const VALID_CREATE_BASE = {
  vehicleId: randomUUID(),
  category: 'insurance' as const,
  dueDate: '2026-12-31',
};

describe('PersonalDeadlineCategoryEnum', () => {
  it.each(['insurance', 'road_tax', 'inspection', 'service', 'tires', 'timing_belt', 'other'])(
    'accepts %s',
    (v) => {
      expect(PersonalDeadlineCategoryEnum.parse(v)).toBe(v);
    },
  );

  it('rejects unknown category', () => {
    expect(() => PersonalDeadlineCategoryEnum.parse('oil_change')).toThrow();
  });
});

describe('BR-294 — customLabel required when category is other', () => {
  // (a) CREATE with category:'other' and no customLabel → fails, error path includes customLabel
  it('rejects category other without customLabel', () => {
    const result = CreatePersonalDeadlineSchema.safeParse({
      ...VALID_CREATE_BASE,
      category: 'other',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('customLabel');
    }
  });

  // (f) CREATE with category:'other' WITH a non-empty customLabel → passes
  it('accepts category other with a non-empty customLabel', () => {
    const result = CreatePersonalDeadlineSchema.safeParse({
      ...VALID_CREATE_BASE,
      category: 'other',
      customLabel: 'Revisione speciale',
    });
    expect(result.success).toBe(true);
  });
});

describe('CreatePersonalDeadlineSchema — defaults', () => {
  // (b) CREATE without reminderLeadDays → parsed result has reminderLeadDays === [30,7,0]
  it('applies default reminderLeadDays when absent', () => {
    const parsed = CreatePersonalDeadlineSchema.parse({ ...VALID_CREATE_BASE });
    expect(parsed.reminderLeadDays).toEqual([30, 7, 0]);
  });

  it('applies default notifyPush true when absent', () => {
    const parsed = CreatePersonalDeadlineSchema.parse({ ...VALID_CREATE_BASE });
    expect(parsed.notifyPush).toBe(true);
  });

  it('applies default notifyEmail true when absent', () => {
    const parsed = CreatePersonalDeadlineSchema.parse({ ...VALID_CREATE_BASE });
    expect(parsed.notifyEmail).toBe(true);
  });
});

describe('CreatePersonalDeadlineSchema — happy path', () => {
  // (c) CREATE valid full body → passes
  it('accepts a valid full body', () => {
    const result = CreatePersonalDeadlineSchema.safeParse({
      vehicleId: randomUUID(),
      category: 'service',
      customLabel: 'Tagliando annuale',
      dueDate: '2027-03-15',
      recurrenceMonths: 12,
      reminderLeadDays: [30, 14, 7],
      reminderDailyTailDays: 3,
      notifyPush: false,
      notifyEmail: true,
      notes: 'Ricordare di cambiare olio',
    });
    expect(result.success).toBe(true);
  });

  it('accepts minimal body with only required fields', () => {
    const result = CreatePersonalDeadlineSchema.safeParse({ ...VALID_CREATE_BASE });
    expect(result.success).toBe(true);
  });
});

describe('CreatePersonalDeadlineSchema — validation', () => {
  it('rejects invalid vehicleId (not a UUID)', () => {
    const result = CreatePersonalDeadlineSchema.safeParse({
      ...VALID_CREATE_BASE,
      vehicleId: 'not-a-uuid',
    });
    expect(result.success).toBe(false);
  });

  it('rejects dueDate with wrong format', () => {
    const result = CreatePersonalDeadlineSchema.safeParse({
      ...VALID_CREATE_BASE,
      dueDate: '31/12/2026',
    });
    expect(result.success).toBe(false);
  });

  it('rejects dueDate with ISO datetime (timestamp)', () => {
    const result = CreatePersonalDeadlineSchema.safeParse({
      ...VALID_CREATE_BASE,
      dueDate: '2026-12-31T00:00:00Z',
    });
    expect(result.success).toBe(false);
  });

  // (e) reminderLeadDays with 11 elements → fails
  it('rejects reminderLeadDays with more than 10 elements', () => {
    const result = CreatePersonalDeadlineSchema.safeParse({
      ...VALID_CREATE_BASE,
      reminderLeadDays: [365, 300, 240, 180, 120, 90, 60, 30, 14, 7, 0],
    });
    expect(result.success).toBe(false);
  });

  it('rejects reminderLeadDays element out of range (> 365)', () => {
    const result = CreatePersonalDeadlineSchema.safeParse({
      ...VALID_CREATE_BASE,
      reminderLeadDays: [366],
    });
    expect(result.success).toBe(false);
  });

  it('rejects reminderLeadDays element out of range (< 0)', () => {
    const result = CreatePersonalDeadlineSchema.safeParse({
      ...VALID_CREATE_BASE,
      reminderLeadDays: [-1],
    });
    expect(result.success).toBe(false);
  });

  it('rejects recurrenceMonths out of range (> 120)', () => {
    const result = CreatePersonalDeadlineSchema.safeParse({
      ...VALID_CREATE_BASE,
      recurrenceMonths: 121,
    });
    expect(result.success).toBe(false);
  });

  it('rejects customLabel exceeding 80 chars', () => {
    const result = CreatePersonalDeadlineSchema.safeParse({
      ...VALID_CREATE_BASE,
      customLabel: 'a'.repeat(81),
    });
    expect(result.success).toBe(false);
  });

  it('rejects notes exceeding 500 chars', () => {
    const result = CreatePersonalDeadlineSchema.safeParse({
      ...VALID_CREATE_BASE,
      notes: 'x'.repeat(501),
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    const result = CreatePersonalDeadlineSchema.safeParse({
      ...VALID_CREATE_BASE,
      unknownField: 'value',
    });
    expect(result.success).toBe(false);
  });
});

describe('UpdatePersonalDeadlineSchema — empty body behavior', () => {
  // (d) UPDATE with body {} → .parse({}) SUCCEEDS and returns an empty object
  // (NO defaults injected — this is the key behavior the route relies on to detect empty body)
  it('parses empty body successfully and returns empty object', () => {
    const result = UpdatePersonalDeadlineSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({});
    }
  });

  it('injects NO defaults on empty body (key count is zero)', () => {
    const parsed = UpdatePersonalDeadlineSchema.parse({});
    expect(Object.keys(parsed).length).toBe(0);
  });
});

describe('UpdatePersonalDeadlineSchema — happy path', () => {
  it('accepts a single field update', () => {
    const result = UpdatePersonalDeadlineSchema.safeParse({ dueDate: '2027-06-01' });
    expect(result.success).toBe(true);
  });

  it('accepts nullable fields set to null (clearing)', () => {
    const result = UpdatePersonalDeadlineSchema.safeParse({
      customLabel: null,
      recurrenceMonths: null,
      reminderDailyTailDays: null,
      notes: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.customLabel).toBeNull();
    }
  });

  it('accepts all optional fields', () => {
    const result = UpdatePersonalDeadlineSchema.safeParse({
      category: 'road_tax',
      customLabel: 'Bollo auto',
      dueDate: '2027-01-01',
      recurrenceMonths: 12,
      reminderLeadDays: [30, 7],
      reminderDailyTailDays: 2,
      notifyPush: true,
      notifyEmail: false,
      notes: 'Scade ogni anno',
    });
    expect(result.success).toBe(true);
  });
});

describe('UpdatePersonalDeadlineSchema — validation', () => {
  it('rejects unknown fields (strict)', () => {
    const result = UpdatePersonalDeadlineSchema.safeParse({ vehicleId: randomUUID() });
    expect(result.success).toBe(false);
  });

  it('rejects reminderLeadDays with 11 elements', () => {
    const result = UpdatePersonalDeadlineSchema.safeParse({
      reminderLeadDays: [365, 300, 240, 180, 120, 90, 60, 30, 14, 7, 0],
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid dueDate format', () => {
    const result = UpdatePersonalDeadlineSchema.safeParse({ dueDate: '2027/01/01' });
    expect(result.success).toBe(false);
  });

  it('rejects customLabel empty string (min 1)', () => {
    const result = UpdatePersonalDeadlineSchema.safeParse({ customLabel: '' });
    expect(result.success).toBe(false);
  });
});
