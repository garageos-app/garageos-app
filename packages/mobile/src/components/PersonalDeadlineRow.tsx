// Row for a single personal deadline (F-CLI-306). Mirrors DeadlineRow's spacing
// and typography. User-facing strings are in Italian.

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { differenceInCalendarDays, parse, startOfToday } from 'date-fns';
import { colors, spacing } from '@/theme/colors';
import { CATEGORY_META, categoryLabel } from '@/lib/personalDeadlineMeta';
import type { PersonalDeadlineDto } from '@/lib/types/personalDeadline';

type Props = {
  deadline: PersonalDeadlineDto;
  onPress: () => void;
};

// Short Italian relative-due label from a bare YYYY-MM-DD due date.
// Returns { label, overdue } so the row can tint past-due items.
function relativeDue(
  dueDate: string,
  status: PersonalDeadlineDto['status'],
): {
  label: string;
  overdue: boolean;
} {
  const due = parse(dueDate, 'yyyy-MM-dd', new Date());
  const diff = differenceInCalendarDays(due, startOfToday());
  const overdue = status === 'overdue' || diff < 0;
  if (diff < 0) return { label: `${Math.abs(diff)} gg fa`, overdue };
  if (diff === 0) return { label: 'Oggi', overdue };
  return { label: `tra ${diff} gg`, overdue };
}

export function PersonalDeadlineRow({ deadline, onPress }: Props) {
  const due = relativeDue(deadline.dueDate, deadline.status);
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={onPress}
      accessibilityRole="button"
    >
      <Ionicons
        name={CATEGORY_META[deadline.category].icon}
        size={24}
        color={colors.muted}
        style={styles.icon}
      />
      <View style={styles.body}>
        <Text style={styles.title}>{categoryLabel(deadline)}</Text>
        <Text style={styles.vehicle}>
          {deadline.vehicle.plate} · {deadline.vehicle.make} {deadline.vehicle.model}
        </Text>
      </View>
      <Text style={[styles.due, due.overdue && styles.dueOverdue]}>{due.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
    gap: spacing.md,
    backgroundColor: colors.bg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowPressed: { backgroundColor: colors.mutedBg },
  icon: { width: 24, textAlign: 'center' },
  body: { flex: 1, gap: spacing.xs },
  title: { fontSize: 15, fontWeight: '600', color: colors.fg },
  vehicle: { fontSize: 13, color: colors.muted },
  due: { fontSize: 13, color: colors.muted, fontWeight: '600' },
  dueOverdue: { color: colors.danger },
});
