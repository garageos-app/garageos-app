import { describe, it, expect } from 'vitest';
import {
  computeReminderSchedule,
  filterFutureSchedules,
  buildPendingSchedules,
  romeTodayDateOnly,
} from '../../../../src/lib/deadlines/compute-reminders.js';

describe('computeReminderSchedule', () => {
  it('returns 3 dates at 08:00 Europe/Rome for a winter date (CET = UTC+1)', () => {
    const result = computeReminderSchedule(new Date('2026-12-31T00:00:00Z'));
    expect(result.tMinus30.toISOString()).toBe('2026-12-01T07:00:00.000Z');
    expect(result.tMinus7.toISOString()).toBe('2026-12-24T07:00:00.000Z');
    expect(result.tZero.toISOString()).toBe('2026-12-31T07:00:00.000Z');
  });

  it('returns 3 dates at 08:00 Europe/Rome for a summer date (CEST = UTC+2)', () => {
    const result = computeReminderSchedule(new Date('2026-07-15T00:00:00Z'));
    expect(result.tMinus30.toISOString()).toBe('2026-06-15T06:00:00.000Z');
    expect(result.tMinus7.toISOString()).toBe('2026-07-08T06:00:00.000Z');
    expect(result.tZero.toISOString()).toBe('2026-07-15T06:00:00.000Z');
  });

  it('handles a leap-year February correctly', () => {
    const result = computeReminderSchedule(new Date('2028-02-29T00:00:00Z'));
    expect(result.tMinus30.toISOString()).toBe('2028-01-30T07:00:00.000Z');
  });

  it('crosses DST boundary correctly when T-30 lands in different offset than T-0', () => {
    // 2026-04-15 is CEST (UTC+2) — tZero at 06:00Z
    // 2026-03-16 is CET  (UTC+1) — tMinus30 at 07:00Z (DST switch was 2026-03-29)
    const result = computeReminderSchedule(new Date('2026-04-15T00:00:00Z'));
    expect(result.tMinus30.toISOString()).toBe('2026-03-16T07:00:00.000Z');
    expect(result.tZero.toISOString()).toBe('2026-04-15T06:00:00.000Z');
  });
});

describe('romeTodayDateOnly', () => {
  it('returns the Rome calendar day as UTC midnight (winter, just after Rome midnight)', () => {
    // 2026-01-15 00:30 Rome (CET = UTC+1) == 2026-01-14 23:30Z. The Rome
    // calendar day is the 15th, so the result must be 2026-01-15T00:00:00Z.
    const result = romeTodayDateOnly(new Date('2026-01-14T23:30:00Z'));
    expect(result.toISOString()).toBe('2026-01-15T00:00:00.000Z');
  });

  it('returns the Rome calendar day as UTC midnight (summer, before Rome midnight)', () => {
    // 2026-07-15 23:30 Rome (CEST = UTC+2) == 2026-07-15 21:30Z. Rome day is
    // still the 15th -> 2026-07-15T00:00:00Z.
    const result = romeTodayDateOnly(new Date('2026-07-15T21:30:00Z'));
    expect(result.toISOString()).toBe('2026-07-15T00:00:00.000Z');
  });

  it('always anchors at exact UTC midnight (time component is zeroed)', () => {
    const result = romeTodayDateOnly(new Date('2026-03-10T13:47:11Z'));
    expect(result.getUTCHours()).toBe(0);
    expect(result.getUTCMinutes()).toBe(0);
    expect(result.getUTCSeconds()).toBe(0);
    expect(result.getUTCMilliseconds()).toBe(0);
  });
});

describe('filterFutureSchedules', () => {
  it('filters out scheduledFor that are in the past or within the clock-skew buffer', () => {
    const now = new Date('2026-05-08T12:00:00Z');
    const result = filterFutureSchedules(
      [
        { reminderType: 't_minus_30', scheduledFor: new Date('2026-04-01T00:00:00Z') },
        { reminderType: 't_minus_7', scheduledFor: new Date('2026-05-08T12:00:30Z') },
        { reminderType: 't_zero', scheduledFor: new Date('2026-05-08T12:02:00Z') },
      ],
      now,
    );
    expect(result.map((r) => r.reminderType)).toEqual(['t_zero']);
  });

  it('keeps all schedules that are comfortably in the future', () => {
    const now = new Date('2026-05-08T12:00:00Z');
    const result = filterFutureSchedules(
      [
        { reminderType: 't_minus_30', scheduledFor: new Date('2026-06-01T07:00:00Z') },
        { reminderType: 't_minus_7', scheduledFor: new Date('2026-06-24T07:00:00Z') },
        { reminderType: 't_zero', scheduledFor: new Date('2026-07-01T07:00:00Z') },
      ],
      now,
    );
    expect(result.map((r) => r.reminderType)).toEqual(['t_minus_30', 't_minus_7', 't_zero']);
  });

  it('drops all schedules when all are in the past', () => {
    const now = new Date('2026-08-01T12:00:00Z');
    const result = filterFutureSchedules(
      [
        { reminderType: 't_minus_30', scheduledFor: new Date('2026-06-01T07:00:00Z') },
        { reminderType: 't_minus_7', scheduledFor: new Date('2026-06-24T07:00:00Z') },
        { reminderType: 't_zero', scheduledFor: new Date('2026-07-01T07:00:00Z') },
      ],
      now,
    );
    expect(result).toHaveLength(0);
  });
});

describe('buildPendingSchedules', () => {
  it('returns all 3 schedules when dueDate is well in the future', () => {
    // Use a fixed past "now" so all three reminders are future
    const now = new Date('2026-05-08T12:00:00Z');
    const set = computeReminderSchedule(new Date('2026-12-31T00:00:00Z'));
    const pending = buildPendingSchedules(set, now);
    expect(pending.map((r) => r.reminderType)).toEqual(['t_minus_30', 't_minus_7', 't_zero']);
  });

  it('returns only future schedules when some are already past', () => {
    // tMinus30 = 2026-12-01T07:00Z, tMinus7 = 2026-12-24T07:00Z, tZero = 2026-12-31T07:00Z
    const now = new Date('2026-12-10T12:00:00Z'); // after tMinus30, before tMinus7
    const set = computeReminderSchedule(new Date('2026-12-31T00:00:00Z'));
    const pending = buildPendingSchedules(set, now);
    expect(pending.map((r) => r.reminderType)).toEqual(['t_minus_7', 't_zero']);
  });

  it('returns empty array when dueDate has fully passed', () => {
    const now = new Date('2027-01-01T12:00:00Z'); // after tZero
    const set = computeReminderSchedule(new Date('2026-12-31T00:00:00Z'));
    const pending = buildPendingSchedules(set, now);
    expect(pending).toHaveLength(0);
  });
});
