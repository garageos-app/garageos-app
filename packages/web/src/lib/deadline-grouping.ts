import type { TenantDeadline } from '@/queries/types';

// Bucket boundaries (relative to `today` at midnight):
//   overdue     dueDate < today          (open status only)
//   thisWeek    today ≤ dueDate ≤ +7d
//   thisMonth   +8d   ≤ dueDate ≤ +30d
//   threeMonths +31d  ≤ dueDate ≤ +90d
//   (>90d, dueDate null, completed/cancelled — all excluded)

export type DeadlineBuckets = {
  overdue: TenantDeadline[];
  thisWeek: TenantDeadline[];
  thisMonth: TenantDeadline[];
  threeMonths: TenantDeadline[];
};

export function isOverdue(d: TenantDeadline, today: Date): boolean {
  if (d.status !== 'open') return false;
  if (!d.dueDate) return false;
  return new Date(d.dueDate) < today;
}

function daysBetween(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

export function groupByDueBucket(items: TenantDeadline[], today: Date): DeadlineBuckets {
  const buckets: DeadlineBuckets = {
    overdue: [],
    thisWeek: [],
    thisMonth: [],
    threeMonths: [],
  };

  for (const item of items) {
    if (!item.dueDate) continue;
    const due = new Date(item.dueDate);

    if (isOverdue(item, today)) {
      buckets.overdue.push(item);
      continue;
    }

    const days = daysBetween(today, due);
    if (days < 0) continue; // overdue + non-open: drop
    if (days <= 7) buckets.thisWeek.push(item);
    else if (days <= 30) buckets.thisMonth.push(item);
    else if (days <= 90) buckets.threeMonths.push(item);
    // > 90 days: dropped
  }

  return buckets;
}
