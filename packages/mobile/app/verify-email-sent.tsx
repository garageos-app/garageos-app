import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useAuth } from '@/auth/useAuth';
import { resendVerification } from '@/queries/signup';
import { mapErrorToUserMessage } from '@/lib/error-messages';
import { colors, spacing } from '@/theme/colors';

const COOLDOWN_SECONDS = 60;

export default function VerifyEmailSent() {
  const router = useRouter();
  const { signOut } = useAuth();
  const params = useLocalSearchParams<{ email?: string }>();
  const email = typeof params.email === 'string' ? params.email : '';
  const [cooldown, setCooldown] = useState(0);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  function startCooldown() {
    setCooldown(COOLDOWN_SECONDS);
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => {
      setCooldown((s) => {
        if (s <= 1) {
          if (intervalRef.current) clearInterval(intervalRef.current);
          intervalRef.current = null;
          return 0;
        }
        return s - 1;
      });
    }, 1000);
  }

  async function handleResend() {
    if (busy || cooldown > 0 || !email) return;
    setBusy(true);
    setFeedback(null);
    const result = await resendVerification(email);
    setBusy(false);
    if (result.ok) {
      setFeedback('Email inviata.');
      startCooldown();
    } else {
      setFeedback(mapErrorToUserMessage(result.code));
    }
  }

  async function handleBackToLogin() {
    await signOut();
    router.replace('/login');
  }

  const resendDisabled = busy || cooldown > 0 || !email;
  const resendLabel = cooldown > 0 ? `Invia di nuovo (${cooldown}s)` : 'Invia di nuovo';

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.brand}>
          <View style={styles.logo}>
            <Text style={styles.logoText}>G</Text>
          </View>
          <Text style={styles.wordmark}>GarageOS</Text>
        </View>

        <Text style={styles.icon}>✉️</Text>
        <Text style={styles.h1}>Conferma la tua email</Text>
        <Text style={styles.body}>
          Abbiamo inviato un link di verifica a <Text style={styles.bodyStrong}>{email}</Text>.
          Clicca sul link per confermare il tuo indirizzo.
        </Text>

        {feedback ? <Text style={styles.feedback}>{feedback}</Text> : null}

        <Pressable
          onPress={handleResend}
          accessibilityRole="button"
          disabled={resendDisabled}
          style={({ pressed }) => [
            styles.secondaryButton,
            pressed && styles.pressed,
            resendDisabled && styles.secondaryDisabled,
          ]}
        >
          {busy ? (
            <ActivityIndicator color={colors.primary} />
          ) : (
            <Text style={styles.secondaryText}>{resendLabel}</Text>
          )}
        </Pressable>

        <Pressable
          onPress={() => router.replace('/(tabs)')}
          accessibilityRole="button"
          style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
        >
          <Text style={styles.primaryText}>Continua</Text>
        </Pressable>

        <Pressable onPress={handleBackToLogin} style={styles.linkRow} accessibilityRole="link">
          <Text style={styles.linkText}>Email sbagliata? Torna al login</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: { flexGrow: 1, justifyContent: 'center', padding: spacing.lg, gap: spacing.md },
  brand: { alignItems: 'center', marginBottom: spacing.lg, gap: spacing.sm },
  logo: {
    width: 56,
    height: 56,
    borderRadius: 12,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoText: { color: colors.primaryFg, fontSize: 28, fontWeight: 'bold' },
  wordmark: { fontSize: 24, fontWeight: '700', color: colors.fg, letterSpacing: -0.5 },
  icon: { fontSize: 56, textAlign: 'center' },
  h1: { fontSize: 22, fontWeight: '700', color: colors.fg, textAlign: 'center' },
  body: { fontSize: 15, color: colors.muted, textAlign: 'center', lineHeight: 22 },
  bodyStrong: { color: colors.fg, fontWeight: '600' },
  feedback: { fontSize: 13, color: colors.muted, textAlign: 'center' },
  primaryButton: {
    backgroundColor: colors.primary,
    paddingVertical: spacing.md,
    borderRadius: 8,
    alignItems: 'center',
  },
  primaryText: { color: colors.primaryFg, fontSize: 16, fontWeight: '600' },
  secondaryButton: {
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.md,
    borderRadius: 8,
    alignItems: 'center',
  },
  secondaryDisabled: { opacity: 0.6 },
  secondaryText: { color: colors.primary, fontSize: 16, fontWeight: '500' },
  pressed: { opacity: 0.8 },
  linkRow: { alignItems: 'center', padding: spacing.sm },
  linkText: { color: colors.primary, fontSize: 14 },
});
