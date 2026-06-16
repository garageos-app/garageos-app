import {
  REMINDER_HOUR_LOCAL,
  SKEW_BUFFER_MS,
  romeDayAtHourUtc,
} from '../deadlines/compute-reminders.js';

// A personal-deadline reminder is either a "lead" reminder (fired N days
// before the due date, e.g. 30/7/0) or a "tail" reminder (fired on each of
// the final K days running up to the due date). See BR-293 / BR-295.
export type PersonalReminderKind = 'lead' | 'tail';

export interface PersonalReminderRow {
  scheduledFor: Date;
  kind: PersonalReminderKind;
}

/**
 * Build the list of personal-deadline reminder rows to be scheduled.
 *
 * Lead reminders fire `d` days before the due date for each `d` in
 * `reminderLeadDays`. The daily tail (if a positive number) fires on each of
 * the final `reminderDailyTailDays` days (offsets 0..tail-1). When the same
 * day-offset is produced by both a lead and the tail, the lead wins. Each row
 * is anchored at 08:00 Europe/Rome wall-clock on its calendar day (DST-aware).
 *
 * Rows whose firing instant is not strictly more than SKEW_BUFFER_MS after
 * `now` are dropped (already fired / too-soon for the scheduler). The result
 * is sorted ascending by `scheduledFor`. See BR-293 (caps) and BR-295 (timing).
 *
 * @param dueDate              - The deadline date (time component ignored).
 * @param reminderLeadDays     - Days-before-due offsets for lead reminders.
 * @param reminderDailyTailDays- Number of trailing daily reminders, or null.
 * @param now                  - Reference instant (defaults to `new Date()`).
 * @returns Sorted, future-only reminder rows.
 */
export function buildPersonalReminders(
  dueDate: Date,
  reminderLeadDays: number[],
  reminderDailyTailDays: number | null,
  now: Date = new Date(),
): PersonalReminderRow[] {
  // Build a map offset -> kind. Lead wins on collision: insert tail offsets
  // first, then let lead offsets overwrite any shared offset.
  const offsetToKind = new Map<number, PersonalReminderKind>();

  if (typeof reminderDailyTailDays === 'number' && reminderDailyTailDays > 0) {
    for (let k = 0; k < reminderDailyTailDays; k++) {
      offsetToKind.set(k, 'tail');
    }
  }

  for (const d of reminderLeadDays) {
    offsetToKind.set(d, 'lead');
  }

  const cutoff = now.getTime() + SKEW_BUFFER_MS;

  const rows: PersonalReminderRow[] = [];
  for (const [offset, kind] of offsetToKind) {
    const scheduledFor = romeDayAtHourUtc(dueDate, -offset, REMINDER_HOUR_LOCAL);
    // BR-295: drop reminders already past or within the clock-skew buffer.
    if (scheduledFor.getTime() > cutoff) {
      rows.push({ scheduledFor, kind });
    }
  }

  rows.sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime());
  return rows;
}
