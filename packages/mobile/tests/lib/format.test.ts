import { formatDate, formatKm, formatTimeAgo } from '@/lib/format';

describe('format', () => {
  describe('formatDate', () => {
    it('formats YYYY-MM-DD to DD/MM/YYYY', () => {
      expect(formatDate('2026-05-14')).toBe('14/05/2026');
    });

    it('returns fallback for invalid input', () => {
      expect(formatDate('not-a-date')).toBe('—');
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
