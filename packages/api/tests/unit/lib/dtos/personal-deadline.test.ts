import { describe, expect, it } from 'vitest';

import { serializePersonalDeadline } from '../../../../src/lib/dtos/personal-deadline.js';

const baseRow = {
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  vehicleId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  category: 'insurance' as const,
  customLabel: null,
  dueDate: new Date('2026-07-10T00:00:00.000Z'),
  recurrenceMonths: null,
  reminderLeadDays: [7, 30],
  reminderDailyTailDays: null,
  notifyPush: true,
  notifyEmail: false,
  status: 'open' as const,
  notes: null,
  completedAt: null,
  createdAt: new Date('2026-06-01T08:00:00.000Z'),
  updatedAt: new Date('2026-06-01T08:00:00.000Z'),
  vehicle: { plate: 'EF456GH', make: 'Toyota', model: 'Yaris' },
};

describe('serializePersonalDeadline', () => {
  it('serializes dueDate as bare YYYY-MM-DD string (not ISO timestamp)', () => {
    const dto = serializePersonalDeadline(baseRow);
    expect(dto.dueDate).toBe('2026-07-10');
  });

  it('does NOT include customerId in the DTO', () => {
    const dto = serializePersonalDeadline(baseRow);
    expect(dto).not.toHaveProperty('customerId');
  });

  it('omits completedAt when null', () => {
    const dto = serializePersonalDeadline(baseRow);
    expect(dto).not.toHaveProperty('completedAt');
  });

  it('includes completedAt as ISO string when set', () => {
    const dto = serializePersonalDeadline({
      ...baseRow,
      status: 'completed' as const,
      completedAt: new Date('2026-07-10T10:00:00.000Z'),
    });
    expect(dto.completedAt).toBe('2026-07-10T10:00:00.000Z');
  });

  it('includes nested vehicle object with plate, make, model', () => {
    const dto = serializePersonalDeadline(baseRow);
    expect(dto.vehicle).toEqual({ plate: 'EF456GH', make: 'Toyota', model: 'Yaris' });
  });

  it('omits optional string/number fields when null', () => {
    const dto = serializePersonalDeadline(baseRow);
    expect(dto).not.toHaveProperty('customLabel');
    expect(dto).not.toHaveProperty('recurrenceMonths');
    expect(dto).not.toHaveProperty('reminderDailyTailDays');
    expect(dto).not.toHaveProperty('notes');
  });

  it('includes optional fields when non-null', () => {
    const dto = serializePersonalDeadline({
      ...baseRow,
      customLabel: 'RC Auto scaduta',
      recurrenceMonths: 12,
      reminderDailyTailDays: 3,
      notes: 'Da rinnovare entro fine mese',
    });
    expect(dto.customLabel).toBe('RC Auto scaduta');
    expect(dto.recurrenceMonths).toBe(12);
    expect(dto.reminderDailyTailDays).toBe(3);
    expect(dto.notes).toBe('Da rinnovare entro fine mese');
  });

  it('serializes createdAt and updatedAt as full ISO strings', () => {
    const dto = serializePersonalDeadline(baseRow);
    expect(dto.createdAt).toBe('2026-06-01T08:00:00.000Z');
    expect(dto.updatedAt).toBe('2026-06-01T08:00:00.000Z');
  });

  it('passes through boolean and array fields unchanged', () => {
    const dto = serializePersonalDeadline(baseRow);
    expect(dto.notifyPush).toBe(true);
    expect(dto.notifyEmail).toBe(false);
    expect(dto.reminderLeadDays).toEqual([7, 30]);
    expect(dto.status).toBe('open');
  });
});
