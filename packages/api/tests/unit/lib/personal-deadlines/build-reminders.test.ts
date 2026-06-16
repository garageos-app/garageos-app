import { describe, it, expect } from 'vitest';
import { buildPersonalReminders } from '../../../../src/lib/personal-deadlines/build-reminders.js';

describe('buildPersonalReminders', () => {
  it('lead [30,7,0], no tail: 3 lead rows at 08:00 Europe/Rome on days -30/-7/0', () => {
    // dueDate well in the future so nothing is filtered by skew.
    const dueDate = new Date('2026-12-31T00:00:00Z');
    const now = new Date('2026-05-08T12:00:00Z');
    const rows = buildPersonalReminders(dueDate, [30, 7, 0], null, now);

    expect(rows.map((r) => r.scheduledFor.toISOString())).toEqual([
      '2026-12-01T07:00:00.000Z', // -30 days, 08:00 CET
      '2026-12-24T07:00:00.000Z', // -7 days, 08:00 CET
      '2026-12-31T07:00:00.000Z', // -0 days, 08:00 CET
    ]);
    expect(rows.map((r) => r.kind)).toEqual(['lead', 'lead', 'lead']);
  });

  it('lead [7] + tail 7: offsets {0..6} tail and {7} lead = 8 rows, no duplicates', () => {
    const dueDate = new Date('2026-12-31T00:00:00Z');
    const now = new Date('2026-05-08T12:00:00Z');
    const rows = buildPersonalReminders(dueDate, [7], 7, now);

    expect(rows).toHaveLength(8);

    // Sorted ascending: earliest is offset 7 (lead), then offsets 6..0 (tail).
    const expected = [
      { iso: '2026-12-24T07:00:00.000Z', kind: 'lead' }, // offset 7
      { iso: '2026-12-25T07:00:00.000Z', kind: 'tail' }, // offset 6
      { iso: '2026-12-26T07:00:00.000Z', kind: 'tail' }, // offset 5
      { iso: '2026-12-27T07:00:00.000Z', kind: 'tail' }, // offset 4
      { iso: '2026-12-28T07:00:00.000Z', kind: 'tail' }, // offset 3
      { iso: '2026-12-29T07:00:00.000Z', kind: 'tail' }, // offset 2
      { iso: '2026-12-30T07:00:00.000Z', kind: 'tail' }, // offset 1
      { iso: '2026-12-31T07:00:00.000Z', kind: 'tail' }, // offset 0
    ];
    expect(rows.map((r) => ({ iso: r.scheduledFor.toISOString(), kind: r.kind }))).toEqual(
      expected,
    );
  });

  it("when an offset is in BOTH lead and tail, the row is 'lead' (lead wins on collision)", () => {
    // lead includes 3; tail=7 covers offsets 0..6 which also includes 3.
    const dueDate = new Date('2026-12-31T00:00:00Z');
    const now = new Date('2026-05-08T12:00:00Z');
    const rows = buildPersonalReminders(dueDate, [3], 7, now);

    // tail offsets 0..6 plus lead offset 3 => still 7 unique offsets (3 is shared).
    expect(rows).toHaveLength(7);

    const offset3Iso = '2026-12-28T07:00:00.000Z'; // -3 days, 08:00 CET
    const offset3Row = rows.find((r) => r.scheduledFor.toISOString() === offset3Iso);
    expect(offset3Row).toBeDefined();
    expect(offset3Row!.kind).toBe('lead');

    // All other rows (0,1,2,4,5,6) are tail.
    const tailCount = rows.filter((r) => r.kind === 'tail').length;
    const leadCount = rows.filter((r) => r.kind === 'lead').length;
    expect(leadCount).toBe(1);
    expect(tailCount).toBe(6);
  });

  it('skew: dueDate today, offset 0, now = today 09:00 Rome drops the 08:00 reminder', () => {
    // dueDate 2026-12-31, offset 0 reminder fires at 08:00 CET = 07:00Z.
    // now is 09:00 Rome (08:00Z), which is past the reminder + skew buffer.
    const dueDate = new Date('2026-12-31T00:00:00Z');
    const now = new Date('2026-12-31T08:00:00Z'); // 09:00 Europe/Rome (CET)
    const rows = buildPersonalReminders(dueDate, [0], null, now);

    expect(rows).toHaveLength(0);
  });

  it('DST: a dueDate straddling the DST switch anchors at 08:00 Rome wall-clock across the boundary', () => {
    // 2026-04-15 is CEST (UTC+2): offset 0 -> 08:00 local = 06:00Z.
    // offset 30 -> 2026-03-16 is CET (UTC+1): 08:00 local = 07:00Z.
    // The DST switch (2026-03-29) sits between the two; UTC hours differ by 1h.
    const dueDate = new Date('2026-04-15T00:00:00Z');
    const now = new Date('2026-01-01T00:00:00Z');
    const rows = buildPersonalReminders(dueDate, [0, 30], null, now);

    const offset0 = rows.find((r) => r.scheduledFor.toISOString() === '2026-04-15T06:00:00.000Z');
    const offset30 = rows.find((r) => r.scheduledFor.toISOString() === '2026-03-16T07:00:00.000Z');
    expect(offset0).toBeDefined();
    expect(offset30).toBeDefined();

    // Both anchor at 08:00 Rome wall-clock; the UTC hour differs by the DST
    // offset (06:00Z in CEST vs 07:00Z in CET) -> exactly 1 hour apart modulo days.
    const utcHour0 = offset0!.scheduledFor.getUTCHours();
    const utcHour30 = offset30!.scheduledFor.getUTCHours();
    expect(utcHour30 - utcHour0).toBe(1);
  });
});
