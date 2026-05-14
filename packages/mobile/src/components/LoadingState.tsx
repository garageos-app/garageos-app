import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { colors, spacing } from '@/theme/colors';

type Props = {
  variant?: 'fullscreen' | 'inline' | 'list';
  message?: string;
};

export function LoadingState({ variant = 'fullscreen', message = 'Caricamento…' }: Props) {
  if (variant === 'list') {
    return (
      <View accessibilityLabel="Caricamento elenco" style={styles.list}>
        {[0, 1, 2].map((i) => (
          <View key={i} style={styles.skeletonRow} />
        ))}
      </View>
    );
  }
  if (variant === 'inline') {
    return <ActivityIndicator size="small" color={colors.primary} />;
  }
  return (
    <View style={styles.fullscreen} accessibilityLabel="Caricamento">
      <ActivityIndicator size="large" color={colors.primary} />
      {message ? <Text style={styles.message}>{message}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fullscreen: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  message: { marginTop: spacing.md, color: colors.muted, fontSize: 14 },
  list: { padding: spacing.md, gap: spacing.md },
  skeletonRow: { height: 72, backgroundColor: colors.mutedBg, borderRadius: 8 },
});
