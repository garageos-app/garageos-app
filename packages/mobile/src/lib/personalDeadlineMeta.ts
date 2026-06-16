// Category metadata, lead-day presets, and bucketing helpers for personal
// deadlines (F-CLI-306). All user-facing strings are in Italian.

import type { ComponentProps } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { differenceInCalendarDays, parse, startOfToday } from 'date-fns';
import type {
  PersonalDeadlineCategory,
  PersonalDeadlineStatus,
} from '@/lib/types/personalDeadline';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

// Italian labels and icons for each deadline category.
export const CATEGORY_META: Record<PersonalDeadlineCategory, { label: string; icon: IoniconName }> =
  {
    insurance: { label: 'Assicurazione', icon: 'shield-checkmark-outline' },
    road_tax: { label: 'Bollo', icon: 'cash-outline' },
    inspection: { label: 'Revisione', icon: 'clipboard-outline' },
    service: { label: 'Tagliando', icon: 'construct-outline' },
    tires: { label: 'Gomme', icon: 'ellipse-outline' },
    timing_belt: { label: 'Cinghia distribuzione', icon: 'cog-outline' },
    other: { label: 'Altro', icon: 'bookmark-outline' },
  };

// Standard reminder lead-day options shown in the form picker (days before due date).
export const LEAD_PRESETS: number[] = [60, 30, 15, 7, 3, 1, 0];

// Returns the display label for a deadline: customLabel wins only when the
// category is 'other' and the label is a non-empty, non-whitespace string.
export function categoryLabel(d: {
  category: PersonalDeadlineCategory;
  customLabel?: string | null;
}): string {
  if (d.category === 'other' && typeof d.customLabel === 'string' && d.customLabel.trim() !== '') {
    return d.customLabel;
  }
  return CATEGORY_META[d.category].label;
}

// Urgency bucket for the list-grouping header. 'overdue' status always wins;
// otherwise the bucket is derived from the calendar diff vs. today.
// See BR-298 for the server-side overdue flip that populates status.
export function urgencyBucket(
  dueDate: string,
  status: PersonalDeadlineStatus,
): 'overdue' | 'week' | 'month' | 'later' {
  if (status === 'overdue') return 'overdue';

  const due = parse(dueDate, 'yyyy-MM-dd', new Date());
  const diff = differenceInCalendarDays(due, startOfToday());

  // A past date with non-overdue status (e.g. open but cron hasn't run yet).
  if (diff < 0) return 'overdue';
  if (diff <= 7) return 'week';
  if (diff <= 31) return 'month';
  return 'later';
}

// Display order for urgency buckets in the list screen.
export const BUCKET_ORDER: Array<'overdue' | 'week' | 'month' | 'later'> = [
  'overdue',
  'week',
  'month',
  'later',
];

// Italian section titles for each urgency bucket.
export const BUCKET_TITLE: Record<'overdue' | 'week' | 'month' | 'later', string> = {
  overdue: 'Scadute',
  week: 'Questa settimana',
  month: 'Questo mese',
  later: 'Oltre',
};
