import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, spacing } from '@/theme/colors';

type Props = {
  message: string;
  onRetry?: () => void;
};

export function ErrorState({ message, onRetry }: Props) {
  return (
    <View style={styles.container} accessibilityRole="alert">
      <Text style={styles.icon}>⚠</Text>
      <Text style={styles.message}>{message}</Text>
      {onRetry ? (
        <Pressable
          onPress={onRetry}
          accessibilityRole="button"
          style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
        >
          <Text style={styles.buttonText}>Riprova</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
    gap: spacing.md,
  },
  icon: { fontSize: 32, color: colors.danger },
  message: { color: colors.fg, fontSize: 14, textAlign: 'center' },
  button: {
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: 8,
  },
  buttonPressed: { opacity: 0.7 },
  buttonText: { color: colors.primaryFg, fontWeight: '600' },
});
