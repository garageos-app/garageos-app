import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, spacing } from '@/theme/colors';
import { formatDueUrgency, formatKm, formatDate, type DueSeverity } from '@/lib/format';
import type { MeDeadline } from '@/lib/types/deadline';

// Severity → badge colors, reusing existing theme tokens (no new colors).
const SEVERITY_COLORS: Record<DueSeverity, { bg: string; fg: string }> = {
  overdue: { bg: colors.dangerBg, fg: colors.danger },
  soon: { bg: colors.warningBg, fg: colors.warningFg },
  normal: { bg: colors.mutedBg, fg: colors.muted },
  none: { bg: colors.mutedBg, fg: colors.muted },
};

type Props = {
  deadline: MeDeadline;
  onPress?: () => void;
  hideVehicle?: boolean;
  highlighted?: boolean;
};

export function DeadlineRow({
  deadline,
  onPress,
  hideVehicle = false,
  highlighted = false,
}: Props) {
  const urgency = formatDueUrgency(deadline.dueDate, deadline.status);
  const sev = SEVERITY_COLORS[urgency.severity];
  return (
    <Pressable
      style={({ pressed }) => [
        styles.row,
        highlighted && styles.rowHighlighted,
        pressed && styles.rowPressed,
      ]}
      onPress={onPress}
      accessibilityRole="button"
    >
      <View style={styles.body}>
        <Text style={styles.title}>{deadline.interventionType.nameIt}</Text>
        {hideVehicle ? null : (
          <Text style={styles.vehicle}>
            {deadline.vehicle.plate} · {deadline.vehicle.make} {deadline.vehicle.model}
          </Text>
        )}
        {deadline.description ? (
          <Text style={styles.description} numberOfLines={2}>
            {deadline.description}
          </Text>
        ) : null}
        {deadline.dueOdometerKm != null ? (
          <Text style={styles.meta}>Alla soglia di {formatKm(deadline.dueOdometerKm)}</Text>
        ) : null}
      </View>
      <View style={styles.right}>
        <View style={[styles.badge, { backgroundColor: sev.bg }]}>
          <Text style={[styles.badgeText, { color: sev.fg }]}>{urgency.label}</Text>
        </View>
        {deadline.dueDate ? (
          <Text style={styles.dueDate}>{formatDate(deadline.dueDate)}</Text>
        ) : null}
      </View>
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
  rowHighlighted: { backgroundColor: colors.highlightBg },
  body: { flex: 1, gap: spacing.xs },
  title: { fontSize: 15, fontWeight: '600', color: colors.fg },
  vehicle: { fontSize: 13, color: colors.muted },
  description: { fontSize: 13, color: colors.fg },
  meta: { fontSize: 12, color: colors.muted },
  right: { alignItems: 'flex-end', gap: spacing.xs },
  badge: { paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, borderRadius: 8 },
  badgeText: { fontSize: 12, fontWeight: '600' },
  dueDate: { fontSize: 12, color: colors.muted },
});
