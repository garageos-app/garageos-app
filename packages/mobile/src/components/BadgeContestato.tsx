import { StyleSheet, Text, View } from 'react-native';
import { colors, spacing } from '@/theme/colors';

export function BadgeContestato() {
  return (
    <View accessibilityLabel="Intervento contestato" style={styles.pill}>
      <Text style={styles.text}>Contestato</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: 999,
    alignSelf: 'flex-start',
    backgroundColor: colors.danger,
  },
  text: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    color: colors.primaryFg,
  },
});
