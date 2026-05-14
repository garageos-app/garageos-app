import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, spacing } from '@/theme/colors';
import type { MeVehicleSummary } from '@/lib/types/vehicle';

type Props = {
  vehicle: MeVehicleSummary;
  onPress: () => void;
};

export function VehicleListItem({ vehicle, onPress }: Props) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${vehicle.make} ${vehicle.model}, targa ${vehicle.plate}`}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.iconWrap}>
        <Text style={styles.icon}>🚗</Text>
      </View>
      <View style={styles.body}>
        <Text style={styles.title}>
          {vehicle.make} {vehicle.model}
        </Text>
        <Text style={styles.plate}>{vehicle.plate}</Text>
        {vehicle.year ? <Text style={styles.year}>Anno {vehicle.year}</Text> : null}
      </View>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 72,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    backgroundColor: colors.bg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  pressed: { backgroundColor: colors.mutedBg },
  iconWrap: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  icon: { fontSize: 28 },
  body: { flex: 1, marginLeft: spacing.md, gap: 2 },
  title: { fontSize: 16, fontWeight: '600', color: colors.fg },
  plate: { fontSize: 13, color: colors.muted },
  year: { fontSize: 12, color: colors.muted, fontStyle: 'italic' },
  chevron: { fontSize: 24, color: colors.muted, marginLeft: spacing.sm },
});
