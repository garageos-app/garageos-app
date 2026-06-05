import { StyleSheet, Text, View } from 'react-native';
import { colors, spacing } from '@/theme/colors';
import { formatDateTime, formatTimeAgo } from '@/lib/format';
import type { CustomerAccessAction, CustomerAccessEntry } from '@/lib/types/accessLog';

// User-facing IT labels (inline, like DeadlineRow — no i18n framework here).
const ACTION_LABEL: Record<CustomerAccessAction, string> = {
  view: 'Consultazione libretto',
  new_intervention: 'Nuovo intervento registrato',
};

export function AccessLogRow({ entry }: { entry: CustomerAccessEntry }) {
  return (
    <View style={styles.row}>
      <View style={styles.body}>
        <Text style={styles.title}>{ACTION_LABEL[entry.action]}</Text>
        <Text style={styles.tenant}>
          {entry.tenantName}
          {entry.locationCity ? ` · ${entry.locationCity}` : ''}
        </Text>
        {entry.mechanicName ? (
          <Text style={styles.mechanic}>Tecnico: {entry.mechanicName}</Text>
        ) : null}
      </View>
      <View style={styles.right}>
        <Text style={styles.ago}>{formatTimeAgo(entry.occurredAt)}</Text>
        <Text style={styles.datetime}>{formatDateTime(entry.occurredAt)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: spacing.md,
    gap: spacing.md,
    backgroundColor: colors.bg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  body: { flex: 1, gap: spacing.xs },
  title: { fontSize: 15, fontWeight: '600', color: colors.fg },
  tenant: { fontSize: 13, color: colors.muted },
  mechanic: { fontSize: 13, color: colors.fg },
  right: { alignItems: 'flex-end', gap: spacing.xs },
  ago: { fontSize: 13, color: colors.fg },
  datetime: { fontSize: 12, color: colors.muted },
});
