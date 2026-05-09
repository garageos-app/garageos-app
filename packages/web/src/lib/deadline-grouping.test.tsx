import { describe, expect, it } from 'vitest';

import { groupByDueBucket, isOverdue } from './deadline-grouping';
import type { TenantDeadline } from '@/queries/types';

const TODAY = new Date('2025-06-15T00:00:00Z');

function makeDeadline(overrides: Partial<TenantDeadline>): TenantDeadline {
  return {
    id: overrides.id ?? 'd1',
    vehicleId: 'v1',
    interventionTypeId: 't1',
    dueDate: overrides.dueDate ?? null,
    dueOdometerKm: overrides.dueOdometerKm ?? null,
    description: null,
    isRecurring: false,
    status: overrides.status ?? 'open',
    vehicle: {
      id: 'v1',
      plate: 'AB123CD',
      make: 'Fiat',
      model: 'Panda',
      currentOwnership: null,
    },
    interventionType: { id: 't1', code: 'TAGLIANDO', nameIt: 'Tagliando' },
  };
}

describe('isOverdue', () => {
  it('returns false for completed deadlines even if dueDate is past', () => {
    const d = makeDeadline({ dueDate: '2025-06-10T00:00:00Z', status: 'completed' });
    expect(isOverdue(d, TODAY)).toBe(false);
  });

  it('returns false for cancelled deadlines', () => {
    const d = makeDeadline({ dueDate: '2025-06-10T00:00:00Z', status: 'cancelled' });
    expect(isOverdue(d, TODAY)).toBe(false);
  });

  it('returns false for null dueDate', () => {
    const d = makeDeadline({ dueDate: null, status: 'open' });
    expect(isOverdue(d, TODAY)).toBe(false);
  });

  it('returns true for open + dueDate < today', () => {
    const d = makeDeadline({ dueDate: '2025-06-10T00:00:00Z', status: 'open' });
    expect(isOverdue(d, TODAY)).toBe(true);
  });

  it('returns false for open + dueDate === today', () => {
    const d = makeDeadline({ dueDate: '2025-06-15T00:00:00Z', status: 'open' });
    expect(isOverdue(d, TODAY)).toBe(false);
  });
});

describe('groupByDueBucket', () => {
  it('returns all empty buckets on empty input', () => {
    const buckets = groupByDueBucket([], TODAY);
    expect(buckets.overdue).toEqual([]);
    expect(buckets.thisWeek).toEqual([]);
    expect(buckets.thisMonth).toEqual([]);
    expect(buckets.threeMonths).toEqual([]);
  });

  it('puts overdue items in the overdue bucket', () => {
    const d = makeDeadline({ id: 'd1', dueDate: '2025-06-10T00:00:00Z', status: 'open' });
    const buckets = groupByDueBucket([d], TODAY);
    expect(buckets.overdue.map((x) => x.id)).toEqual(['d1']);
    expect(buckets.thisWeek).toEqual([]);
  });

  it('puts items within 7 days in thisWeek', () => {
    const d = makeDeadline({ id: 'd2', dueDate: '2025-06-20T00:00:00Z' });
    const buckets = groupByDueBucket([d], TODAY);
    expect(buckets.thisWeek.map((x) => x.id)).toEqual(['d2']);
  });

  it('puts items beyond 7 and within 30 days in thisMonth', () => {
    const d = makeDeadline({ id: 'd3', dueDate: '2025-07-10T00:00:00Z' });
    const buckets = groupByDueBucket([d], TODAY);
    expect(buckets.thisMonth.map((x) => x.id)).toEqual(['d3']);
  });

  it('puts items beyond 30 and within 90 days in threeMonths', () => {
    const d = makeDeadline({ id: 'd4', dueDate: '2025-08-15T00:00:00Z' });
    const buckets = groupByDueBucket([d], TODAY);
    expect(buckets.threeMonths.map((x) => x.id)).toEqual(['d4']);
  });

  it('excludes items beyond 90 days', () => {
    const d = makeDeadline({ id: 'd5', dueDate: '2026-01-01T00:00:00Z' });
    const buckets = groupByDueBucket([d], TODAY);
    expect(buckets.overdue).toEqual([]);
    expect(buckets.thisWeek).toEqual([]);
    expect(buckets.thisMonth).toEqual([]);
    expect(buckets.threeMonths).toEqual([]);
  });

  it('excludes items with null dueDate from all buckets', () => {
    const d = makeDeadline({ id: 'd6', dueDate: null, dueOdometerKm: 30000 });
    const buckets = groupByDueBucket([d], TODAY);
    expect(buckets.overdue).toEqual([]);
    expect(buckets.thisWeek).toEqual([]);
    expect(buckets.thisMonth).toEqual([]);
    expect(buckets.threeMonths).toEqual([]);
  });

  it('correctly buckets a mixed dataset', () => {
    const items = [
      makeDeadline({ id: 'overdue1', dueDate: '2025-06-01T00:00:00Z', status: 'open' }),
      makeDeadline({ id: 'week1', dueDate: '2025-06-18T00:00:00Z' }),
      makeDeadline({ id: 'month1', dueDate: '2025-07-01T00:00:00Z' }),
      makeDeadline({ id: 'three1', dueDate: '2025-08-01T00:00:00Z' }),
      makeDeadline({ id: 'far', dueDate: '2026-01-01T00:00:00Z' }),
      makeDeadline({ id: 'nodate', dueDate: null }),
    ];
    const buckets = groupByDueBucket(items, TODAY);
    expect(buckets.overdue.map((x) => x.id)).toEqual(['overdue1']);
    expect(buckets.thisWeek.map((x) => x.id)).toEqual(['week1']);
    expect(buckets.thisMonth.map((x) => x.id)).toEqual(['month1']);
    expect(buckets.threeMonths.map((x) => x.id)).toEqual(['three1']);
  });

  it('handles bucket boundary days correctly (0, 7, 8, 30, 31, 90, 91 from today)', () => {
    const items = [
      makeDeadline({ id: 'today0', dueDate: '2025-06-15T00:00:00Z' }),
      makeDeadline({ id: 'day7', dueDate: '2025-06-22T00:00:00Z' }),
      makeDeadline({ id: 'day8', dueDate: '2025-06-23T00:00:00Z' }),
      makeDeadline({ id: 'day30', dueDate: '2025-07-15T00:00:00Z' }),
      makeDeadline({ id: 'day31', dueDate: '2025-07-16T00:00:00Z' }),
      makeDeadline({ id: 'day90', dueDate: '2025-09-13T00:00:00Z' }),
      makeDeadline({ id: 'day91', dueDate: '2025-09-14T00:00:00Z' }),
    ];
    const buckets = groupByDueBucket(items, TODAY);
    expect(buckets.thisWeek.map((x) => x.id).sort()).toEqual(['day7', 'today0']);
    expect(buckets.thisMonth.map((x) => x.id).sort()).toEqual(['day30', 'day8']);
    expect(buckets.threeMonths.map((x) => x.id).sort()).toEqual(['day31', 'day90']);
    // day91 (>90d) is excluded from all buckets
    expect(buckets.overdue).toEqual([]);
  });
});
