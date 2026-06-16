import { addDays, format, startOfToday } from 'date-fns';
import { categoryLabel, urgencyBucket } from '@/lib/personalDeadlineMeta';

// Helper: build a YYYY-MM-DD string that is `n` calendar days from today.
const relDate = (n: number): string => format(addDays(startOfToday(), n), 'yyyy-MM-dd');

describe('categoryLabel', () => {
  it('returns customLabel for category "other" with a non-empty label', () => {
    expect(categoryLabel({ category: 'other', customLabel: 'Bollo auto' })).toBe('Bollo auto');
  });

  it('returns the category meta label for "other" with an empty customLabel', () => {
    expect(categoryLabel({ category: 'other', customLabel: '' })).toBe('Altro');
  });

  it('returns the category meta label for "other" with a whitespace-only customLabel', () => {
    expect(categoryLabel({ category: 'other', customLabel: '   ' })).toBe('Altro');
  });

  it('returns the category meta label for "other" with a null customLabel', () => {
    expect(categoryLabel({ category: 'other', customLabel: null })).toBe('Altro');
  });

  it('ignores customLabel for a non-"other" category', () => {
    expect(categoryLabel({ category: 'insurance', customLabel: 'x' })).toBe('Assicurazione');
  });
});

describe('urgencyBucket', () => {
  it('returns "overdue" when status is "overdue" regardless of date', () => {
    expect(urgencyBucket('2099-12-31', 'overdue')).toBe('overdue');
  });

  it('returns "overdue" for status "open" with a dueDate 5 days in the past', () => {
    expect(urgencyBucket(relDate(-5), 'open')).toBe('overdue');
  });

  it('returns "week" for status "open" with a dueDate 3 days ahead', () => {
    expect(urgencyBucket(relDate(3), 'open')).toBe('week');
  });

  it('returns "month" for status "open" with a dueDate 20 days ahead', () => {
    expect(urgencyBucket(relDate(20), 'open')).toBe('month');
  });

  it('returns "later" for status "open" with a dueDate 200 days ahead', () => {
    expect(urgencyBucket(relDate(200), 'open')).toBe('later');
  });

  it('returns "week" for status "open" with dueDate exactly today (0 days)', () => {
    expect(urgencyBucket(relDate(0), 'open')).toBe('week');
  });

  it('returns "week" for status "open" with dueDate 7 days ahead', () => {
    expect(urgencyBucket(relDate(7), 'open')).toBe('week');
  });

  it('returns "month" for status "open" with dueDate 31 days ahead', () => {
    expect(urgencyBucket(relDate(31), 'open')).toBe('month');
  });

  it('returns "later" for a completed deadline well in the future', () => {
    expect(urgencyBucket(relDate(100), 'completed')).toBe('later');
  });
});
