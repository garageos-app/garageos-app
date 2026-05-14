import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '@/auth/useAuth';
import { colors, spacing } from '@/theme/colors';

export default function ProfileScreen() {
  const { email, signOut } = useAuth();
  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.label}>Account</Text>
        <Text style={styles.value}>{email ?? '—'}</Text>
      </View>
      <View style={styles.card}>
        <Text style={styles.placeholder}>
          La gestione completa del profilo è disponibile a breve.
        </Text>
      </View>
      <Pressable
        onPress={() => void signOut()}
        accessibilityRole="button"
        style={({ pressed }) => [styles.signOut, pressed && styles.signOutPressed]}
      >
        <Text style={styles.signOutText}>Esci</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: spacing.lg, gap: spacing.md, backgroundColor: colors.bg },
  card: {
    backgroundColor: colors.mutedBg,
    padding: spacing.md,
    borderRadius: 8,
    gap: spacing.xs,
  },
  label: { fontSize: 12, color: colors.muted, textTransform: 'uppercase', letterSpacing: 0.5 },
  value: { fontSize: 16, color: colors.fg },
  placeholder: { fontSize: 14, color: colors.muted, fontStyle: 'italic' },
  signOut: {
    marginTop: 'auto',
    backgroundColor: colors.danger,
    padding: spacing.md,
    borderRadius: 8,
    alignItems: 'center',
  },
  signOutPressed: { opacity: 0.8 },
  signOutText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
});
