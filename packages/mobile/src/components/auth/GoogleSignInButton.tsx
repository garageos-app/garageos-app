import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';
import { colors, spacing } from '@/theme/colors';

interface GoogleSignInButtonProps {
  label: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
}

/**
 * Presentational Google sign-in button. No OAuth logic inside.
 * Rendered as a secondary (bordered, neutral) button so it reads as an
 * alternative to the primary blue submit button.
 */
export function GoogleSignInButton({ label, onPress, loading, disabled }: GoogleSignInButtonProps) {
  const isDisabled = loading || disabled;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={isDisabled}
      onPress={isDisabled ? undefined : onPress}
      style={({ pressed }) => [
        styles.button,
        pressed && !isDisabled && styles.pressed,
        isDisabled && styles.buttonDisabled,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={colors.muted} />
      ) : (
        <Text style={[styles.label, isDisabled && styles.labelDisabled]}>{label}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingVertical: spacing.md,
    alignItems: 'center',
    backgroundColor: colors.bg,
  },
  pressed: { opacity: 0.7 },
  buttonDisabled: { borderColor: colors.border, backgroundColor: colors.mutedBg },
  label: { color: colors.fg, fontSize: 16, fontWeight: '500' },
  labelDisabled: { color: colors.muted },
});
