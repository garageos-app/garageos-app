import { formatDate, formatDueUrgency, formatKm, formatTimeAgo } from '@/lib/format';

describe('format', () => {
  describe('formatDate', () => {
    it('formats YYYY-MM-DD to DD/MM/YYYY', () => {
      expect(formatDate('2026-05-14')).toBe('14/05/2026');
    });

    it('returns fallback for invalid input', () => {
      expect(formatDate('not-a-date')).toBe('—');
    });

    it('accepts an ISO datetime (API @db.Date wire shape) and formats the date part', () => {
      expect(formatDate('2026-06-10T00:00:00.000Z')).toBe('10/06/2026');
    });
  });

  describe('formatKm', () => {
    it('formats with thousands separator', () => {
      expect(formatKm(125000)).toBe('125.000 km');
    });

    it('handles zero', () => {
      expect(formatKm(0)).toBe('0 km');
    });
  });

  describe('formatTimeAgo', () => {
    it('returns "oggi" for today', () => {
      const today = new Date().toISOString().slice(0, 10);
      expect(formatTimeAgo(today)).toBe('oggi');
    });

    it('returns "ieri" for yesterday', () => {
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      expect(formatTimeAgo(yesterday)).toBe('ieri');
    });
  });
});

describe('formatDueUrgency', () => {
  // Derive inputs relative to "now" — same approach as the formatTimeAgo tests
  // above — so assertions never depend on a hardcoded run date. (The helper
  // computes "today" from new Date(); mocking Date.now would not affect it.)
  const dateInDays = (n: number): string =>
    new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

  it('returns Scaduta for status overdue regardless of date', () => {
    expect(formatDueUrgency('2099-01-01', 'overdue')).toEqual({
      label: 'Scaduta',
      severity: 'overdue',
    });
  });

  it('returns Scaduta for a past dueDate with open status', () => {
    expect(formatDueUrgency(dateInDays(-3), 'open')).toEqual({
      label: 'Scaduta',
      severity: 'overdue',
    });
  });

  it('returns Oggi for today', () => {
    expect(formatDueUrgency(dateInDays(0), 'open')).toEqual({ label: 'Oggi', severity: 'soon' });
  });

  it('returns Domani for tomorrow', () => {
    expect(formatDueUrgency(dateInDays(1), 'open')).toEqual({ label: 'Domani', severity: 'soon' });
  });

  it('returns days for within a week', () => {
    expect(formatDueUrgency(dateInDays(5), 'open')).toEqual({
      label: 'Tra 5 giorni',
      severity: 'soon',
    });
  });

  it('returns singular week at 10 days', () => {
    expect(formatDueUrgency(dateInDays(10), 'open')).toEqual({
      label: 'Tra 1 settimana',
      severity: 'normal',
    });
  });

  it('returns plural weeks at 21 days', () => {
    expect(formatDueUrgency(dateInDays(21), 'open')).toEqual({
      label: 'Tra 3 settimane',
      severity: 'normal',
    });
  });

  it('returns an absolute date beyond 30 days', () => {
    const future = dateInDays(60);
    expect(formatDueUrgency(future, 'open')).toEqual({
      label: formatDate(future),
      severity: 'normal',
    });
  });

  it('returns none for a km-only deadline (null date)', () => {
    expect(formatDueUrgency(null, 'open')).toEqual({ label: '—', severity: 'none' });
  });

  it('returns none for an invalid date', () => {
    expect(formatDueUrgency('not-a-date', 'open')).toEqual({ label: '—', severity: 'none' });
  });

  // The API serializes dueDate (@db.Date) as a full ISO datetime, not YYYY-MM-DD.
  const isoInDays = (n: number): string => new Date(Date.now() + n * 86400000).toISOString();

  it('accepts an ISO datetime wire shape and computes urgency from the date part', () => {
    expect(formatDueUrgency(isoInDays(5), 'open')).toEqual({
      label: 'Tra 5 giorni',
      severity: 'soon',
    });
  });
});
