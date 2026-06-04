import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, spacing } from '@/theme/colors';
import { BadgeCertificato } from './BadgeCertificato';
import { formatDate, formatKm } from '@/lib/format';
import type { TimelineItem } from '@/lib/types/vehicle';

type Props = { item: TimelineItem; onPress?: () => void };

export function TimelineRow({ item, onPress }: Props) {
  const isShop = item.kind === 'shop_intervention';
  // Narrow via discriminant: shop has `title`, private has `custom_type` (nullable).
  const title = isShop ? item.title : (item.custom_type ?? '—');
  const description = item.description;
  const content = (
    <View style={styles.row}>
      <View style={styles.dateCol}>
        <Text style={styles.dateText}>{formatDate(item.intervention_date)}</Text>
      </View>
      <View style={styles.line}>
        <View style={[styles.dot, isShop ? styles.dotShop : styles.dotPrivate]} />
      </View>
      <View style={styles.body}>
        <View style={styles.badgeRow}>
          <BadgeCertificato variant={isShop ? 'certificato' : 'privato'} />
          {isShop ? <Text style={styles.tenantName}>{item.tenant.business_name}</Text> : null}
        </View>
        <Text style={styles.title}>{title}</Text>
        {description ? (
          <Text style={styles.description} numberOfLines={2}>
            {description}
          </Text>
        ) : null}
        <View style={styles.metaRow}>
          <Text style={styles.meta}>{formatKm(item.odometer_km)}</Text>
          {isShop && item.parts_replaced_count > 0 ? (
            <Text style={styles.meta}>{item.parts_replaced_count} pezzi</Text>
          ) : null}
          {item.attachments_count > 0 ? (
            <Text style={styles.meta}>{item.attachments_count} allegati</Text>
          ) : null}
        </View>
      </View>
    </View>
  );

  return onPress ? (
    <Pressable onPress={onPress} accessibilityRole="button">
      {content}
    </Pressable>
  ) : (
    content
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', padding: spacing.md, gap: spacing.md, backgroundColor: colors.bg },
  dateCol: { width: 64 },
  dateText: { fontSize: 12, color: colors.muted },
  line: { width: 12, alignItems: 'center', paddingTop: 4 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  dotShop: { backgroundColor: colors.certificato },
  dotPrivate: { backgroundColor: colors.privato },
  body: { flex: 1, gap: spacing.xs },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  tenantName: { fontSize: 12, color: colors.muted, fontWeight: '600' },
  title: { fontSize: 15, fontWeight: '600', color: colors.fg },
  description: { fontSize: 13, color: colors.fg },
  metaRow: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.xs },
  meta: { fontSize: 12, color: colors.muted },
});
