import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, spacing } from '@/theme/colors';

type Cta = { label: string; onPress: () => void; disabled?: boolean };
type Props = {
  title: string;
  body?: string;
  cta?: Cta;
};

export function EmptyState({ title, body, cta }: Props) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>{title}</Text>
      {body ? <Text style={styles.body}>{body}</Text> : null}
      {cta ? (
        <Pressable
          onPress={cta.disabled ? undefined : cta.onPress}
          accessibilityRole="button"
          disabled={cta.disabled}
          style={({ pressed }) => [
            styles.button,
            pressed && !cta.disabled && styles.buttonPressed,
            cta.disabled && styles.buttonDisabled,
          ]}
        >
          <Text style={[styles.buttonText, cta.disabled && styles.buttonTextDisabled]}>
            {cta.label}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.md,
  },
  title: { fontSize: 18, fontWeight: '600', color: colors.fg, textAlign: 'center' },
  body: { fontSize: 14, color: colors.muted, textAlign: 'center' },
  button: {
    marginTop: spacing.md,
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: 8,
  },
  buttonPressed: { opacity: 0.7 },
  buttonDisabled: { backgroundColor: colors.mutedBg },
  buttonText: { color: colors.primaryFg, fontWeight: '600' },
  buttonTextDisabled: { color: colors.muted },
});
