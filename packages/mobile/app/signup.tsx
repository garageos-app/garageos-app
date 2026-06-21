import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useAuth } from '@/auth/useAuth';
import { GoogleSignInButton } from '@/components/auth/GoogleSignInButton';
import { SignupForm, type SignupFormPayload } from '@/components/auth/SignupForm';
import { mapErrorToUserMessage } from '@/lib/error-messages';
import { signupCustomer } from '@/queries/signup';
import { colors, spacing } from '@/theme/colors';

export default function Signup() {
  const { signIn, signInWithGoogle } = useAuth();
  const router = useRouter();
  const [googleSubmitting, setGoogleSubmitting] = useState(false);
  const [googleError, setGoogleError] = useState<string | null>(null);

  async function handleSubmit(payload: SignupFormPayload) {
    const result = await signupCustomer(payload);
    if (!result.ok) {
      return result;
    }
    try {
      await signIn(payload.email, payload.password);
      router.replace({
        pathname: '/verify-email-sent',
        params: { email: payload.email },
      });
    } catch {
      // Signup succeeded server-side but Cognito SRP failed (eventual
      // consistency or transient). Tell the user to log in manually.
      router.replace('/login');
    }
    return { ok: true as const };
  }

  async function handleGoogle() {
    if (googleSubmitting) return;
    setGoogleError(null);
    setGoogleSubmitting(true);
    try {
      await signInWithGoogle();
      // Google users have a verified email — go straight to the app, skip verify-email-sent.
      router.replace('/(tabs)');
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      // auth.google.cancelled is a silent cancel — no banner needed.
      if (code !== 'auth.google.cancelled') {
        setGoogleError(mapErrorToUserMessage(code));
      }
    } finally {
      setGoogleSubmitting(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.flex}
      >
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          {googleError ? (
            <View style={styles.errorBanner} accessibilityRole="alert">
              <Text style={styles.errorText}>{googleError}</Text>
            </View>
          ) : null}
          <SignupForm onSubmit={handleSubmit} onNavigateLogin={() => router.back()} />
          <View style={styles.dividerRow}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>oppure</Text>
            <View style={styles.dividerLine} />
          </View>
          <GoogleSignInButton
            label="Registrati con Google"
            loading={googleSubmitting}
            onPress={handleGoogle}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  scroll: { flexGrow: 1, justifyContent: 'center', padding: spacing.lg, gap: spacing.md },
  errorBanner: {
    backgroundColor: colors.dangerBg,
    padding: spacing.md,
    borderRadius: 8,
    borderLeftWidth: 4,
    borderLeftColor: colors.danger,
  },
  errorText: { color: colors.danger, fontSize: 13 },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.border },
  dividerText: { color: colors.muted, fontSize: 13 },
});
