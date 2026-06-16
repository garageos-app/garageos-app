// DeadlineReminderType mirrors the Prisma-generated enum values (enums.ts).
// We redeclare it here as a string union to avoid a direct import from the
// generated output path; the shape must stay in sync with the DB enum.
// See: packages/database/prisma/generated/prisma/client/enums.ts
export type DeadlineReminderType = 't_minus_30' | 't_minus_7' | 't_zero' | 'km_reached';

const ROME = 'Europe/Rome';
export const REMINDER_HOUR_LOCAL = 8;

// Clock-skew buffer: schedules within 60 seconds of "now" are treated as
// already expired so we never attempt to create an AWS EventBridge schedule
// with a firing time the service would reject as too-soon. See BR-103.
export const SKEW_BUFFER_MS = 60_000;

export interface ReminderSchedule {
  reminderType: DeadlineReminderType;
  scheduledFor: Date;
}

export interface ComputedReminderSet {
  tMinus30: Date;
  tMinus7: Date;
  tZero: Date;
}

// Convert a calendar date expressed as Europe/Rome wall-clock date at a given
// local hour to a UTC Date instance.
//
// Strategy: start with a UTC candidate assuming the desired offset, then read
// back the actual Europe/Rome hour via Intl.DateTimeFormat and correct for
// any DST difference. One correction is always sufficient because DST offsets
// are at most ±1 h.
function romeLocalToUtc(year: number, month1: number, day: number, hour: number): Date {
  // First candidate: pretend UTC == local (offset 0) to land somewhere near
  // the right neighbourhood, then let Intl tell us the real Rome hour.
  const candidate = new Date(Date.UTC(year, month1 - 1, day, hour, 0, 0));

  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: ROME,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(candidate).map((p) => [p.type, p.value]));
  const romeHour = parseInt(parts['hour']!, 10);

  // romeHour is the wall clock hour in Rome for our UTC candidate.
  // We want the candidate where romeHour == hour, so we subtract the diff.
  const offsetHours = romeHour - hour;
  return new Date(candidate.getTime() - offsetHours * 3_600_000);
}

// Shift a calendar date by deltaDays (positive = future, negative = past)
// using UTC arithmetic so calendar wrap-around (month/year boundaries,
// leap years) is handled correctly.
function shiftCalendarDays(
  year: number,
  month1: number,
  day: number,
  deltaDays: number,
): { year: number; month1: number; day: number } {
  const ms = Date.UTC(year, month1 - 1, day) + deltaDays * 86_400_000;
  const d = new Date(ms);
  return { year: d.getUTCFullYear(), month1: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * Compute the UTC instant for the Europe/Rome calendar date of `baseDate`
 * shifted by `deltaDays`, anchored at `hourLocal` (default 08:00) Rome
 * wall-clock time. Fully DST-aware via Intl.DateTimeFormat.
 *
 * The time-of-day component of `baseDate` is ignored — only its Europe/Rome
 * calendar date is used. See BR-103 / BR-295.
 *
 * @param baseDate  - The reference date (time component ignored).
 * @param deltaDays - Calendar-day shift (negative = before baseDate).
 * @param hourLocal - Rome-local hour to anchor at (default REMINDER_HOUR_LOCAL).
 * @returns UTC Date for the shifted Rome calendar day at `hourLocal` local.
 */
export function romeDayAtHourUtc(
  baseDate: Date,
  deltaDays: number,
  hourLocal: number = REMINDER_HOUR_LOCAL,
): Date {
  // Extract the Europe/Rome calendar date from baseDate, ignoring any
  // time-of-day component so the anchor is always at hourLocal local.
  const dateFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: ROME,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = Object.fromEntries(dateFmt.formatToParts(baseDate).map((p) => [p.type, p.value]));
  const year = parseInt(parts['year']!, 10);
  const month1 = parseInt(parts['month']!, 10);
  const day = parseInt(parts['day']!, 10);

  const shifted = shiftCalendarDays(year, month1, day, deltaDays);
  return romeLocalToUtc(shifted.year, shifted.month1, shifted.day, hourLocal);
}

/**
 * Compute the Europe/Rome calendar date of `now` as a UTC-midnight Date.
 *
 * Prisma returns `@db.Date` columns as JS Dates at UTC midnight of the
 * calendar day, so a sweep that compares `dueDate`/`scheduledFor` against
 * "today" must anchor today at UTC midnight of the *Rome* calendar day —
 * not at the host's local midnight or at UTC's. This is DST-agnostic: only
 * the Y-M-D in Rome matters, the result is always 00:00:00.000Z of that day.
 *
 * @param now - Reference instant (defaults to `new Date()`).
 * @returns A Date at UTC midnight of the Europe/Rome calendar day of `now`.
 */
export function romeTodayDateOnly(now: Date = new Date()): Date {
  const dateFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: ROME,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = Object.fromEntries(dateFmt.formatToParts(now).map((p) => [p.type, p.value]));
  const year = parseInt(parts['year']!, 10);
  const month1 = parseInt(parts['month']!, 10);
  const day = parseInt(parts['day']!, 10);
  return new Date(Date.UTC(year, month1 - 1, day));
}

/**
 * Given a deadline due date, compute the three UTC instants at which
 * reminder notifications should fire: T-30 days, T-7 days, and T-0.
 *
 * Each instant is anchored to 08:00 Europe/Rome local time on the
 * respective calendar day, fully DST-aware via Intl.DateTimeFormat.
 *
 * The time-of-day component of `dueDate` is ignored — only the calendar
 * date in Europe/Rome is used. See BR-103.
 *
 * @param dueDate - The deadline date (time component ignored).
 * @returns ComputedReminderSet with tMinus30, tMinus7, tZero as UTC Dates.
 */
export function computeReminderSchedule(dueDate: Date): ComputedReminderSet {
  return {
    tMinus30: romeDayAtHourUtc(dueDate, -30),
    tMinus7: romeDayAtHourUtc(dueDate, -7),
    tZero: romeDayAtHourUtc(dueDate, 0),
  };
}

/**
 * Filter a list of reminder schedules, retaining only those whose
 * `scheduledFor` is strictly more than SKEW_BUFFER_MS (60 s) after `now`.
 *
 * Schedules at or before that cutoff are considered "already fired" and
 * must not be submitted to the EventBridge Scheduler (it rejects past
 * or near-past targets). See BR-103.
 *
 * @param schedules - Candidate schedules to filter.
 * @param now       - Reference instant (defaults to `new Date()`).
 * @returns Schedules that are sufficiently in the future.
 */
export function filterFutureSchedules(
  schedules: ReminderSchedule[],
  now: Date = new Date(),
): ReminderSchedule[] {
  const cutoff = now.getTime() + SKEW_BUFFER_MS;
  return schedules.filter((s) => s.scheduledFor.getTime() > cutoff);
}

/**
 * Given a pre-computed ComputedReminderSet, return only the schedules
 * that still need to be created (i.e. their `scheduledFor` is in the
 * future beyond the clock-skew buffer).
 *
 * Note: `km_reached` is intentionally not produced here. BR-103 reminders
 * are driven by `due_date` only. The enum value remains in the schema for
 * future km-tracking infrastructure (out of scope for H3).
 *
 * @param set - The three computed reminder instants.
 * @param now - Reference instant (defaults to `new Date()`).
 * @returns Filtered list of ReminderSchedule objects to be scheduled.
 */
export function buildPendingSchedules(
  set: ComputedReminderSet,
  now: Date = new Date(),
): ReminderSchedule[] {
  return filterFutureSchedules(
    [
      { reminderType: 't_minus_30', scheduledFor: set.tMinus30 },
      { reminderType: 't_minus_7', scheduledFor: set.tMinus7 },
      { reminderType: 't_zero', scheduledFor: set.tZero },
    ],
    now,
  );
}
