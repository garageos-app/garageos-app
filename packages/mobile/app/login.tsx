import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useAuth } from '@/auth/useAuth';
import { GoogleSignInButton } from '@/components/auth/GoogleSignInButton';
import { mapErrorToUserMessage } from '@/lib/error-messages';
import { colors, spacing } from '@/theme/colors';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function Login() {
  const { signIn, signInWithGoogle } = useAuth();
  const router = useRouter();
  const params = useLocalSearchParams<{
    reset?: string;
    claimCode?: string;
    googleError?: string;
  }>();
  const justReset = params.reset === '1';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [googleSubmitting, setGoogleSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validation, setValidation] = useState<{ email?: string; password?: string }>({});

  // A failed Google sign-in redirects back here with ?googleError=1 (the error
  // surfaces via param because the OAuth redirect lands on /auth/callback, not on
  // this screen's state). Native-login errors use the `error` state directly.
  const googleErrorMsg =
    params.googleError === '1' ? mapErrorToUserMessage('auth.google.exchange_failed') : null;
  const displayError = error ?? googleErrorMsg;

  async function handleSubmit() {
    if (submitting) return;
    const v: { email?: string; password?: string } = {};
    if (!email) v.email = 'Email obbligatoria';
    else if (!EMAIL_REGEX.test(email)) v.email = 'Email non valida';
    if (!password) v.password = 'Password obbligatoria';
    setValidation(v);
    if (v.email || v.password) return;
    setError(null);
    setSubmitting(true);
    try {
      await signIn(email.trim(), password);
      // A deep-link claim deferred through login (app/v/[code].tsx) carries the
      // code in ?claimCode; land the user on the pre-filled claim form.
      router.replace(params.claimCode ? `/claim-vehicle?code=${params.claimCode}` : '/(tabs)');
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      setError(mapErrorToUserMessage(code));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleGoogle() {
    if (googleSubmitting || submitting) return;
    setError(null);
    setGoogleSubmitting(true);
    try {
      await signInWithGoogle();
      // A deep-link claim deferred through login carries the code in ?claimCode;
      // use the same navigation logic as the password submit. See handleSubmit above.
      router.replace(params.claimCode ? `/claim-vehicle?code=${params.claimCode}` : '/(tabs)');
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      if (code !== 'auth.google.cancelled') {
        // The OAuth redirect lands on /auth/callback; navigate back to login with
        // a param-driven banner so the error is visible (setError on this screen
        // would stay hidden behind the callback route).
        const claimQs = params.claimCode ? `&claimCode=${params.claimCode}` : '';
        router.replace(`/login?googleError=1${claimQs}`);
      }
    } finally {
      setGoogleSubmitting(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.container}
      >
        <View style={styles.brand}>
          <View style={styles.logo}>
            <Text style={styles.logoText}>G</Text>
          </View>
          <Text style={styles.wordmark}>GarageOS</Text>
        </View>
        {justReset && !displayError ? (
          <View style={styles.successBanner} accessibilityRole="alert">
            <Text style={styles.successText}>
              Password aggiornata. Effettua l&apos;accesso con la nuova password.
            </Text>
          </View>
        ) : null}
        {displayError ? (
          <View style={styles.errorBanner} accessibilityRole="alert">
            <Text style={styles.errorText}>{displayError}</Text>
          </View>
        ) : null}
        <View style={styles.field}>
          <Text style={styles.label}>Email</Text>
          <TextInput
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            placeholder="Email"
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            editable={!submitting}
          />
          {validation.email ? <Text style={styles.fieldError}>{validation.email}</Text> : null}
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>Password</Text>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            placeholder="Password"
            secureTextEntry
            autoCapitalize="none"
            autoComplete="password"
            editable={!submitting}
          />
          {validation.password ? (
            <Text style={styles.fieldError}>{validation.password}</Text>
          ) : null}
        </View>
        <Pressable
          onPress={handleSubmit}
          accessibilityRole="button"
          disabled={submitting || googleSubmitting}
          style={({ pressed }) => [
            styles.submit,
            pressed && styles.submitPressed,
            (submitting || googleSubmitting) && styles.submitDisabled,
          ]}
        >
          {submitting ? (
            <ActivityIndicator color={colors.primaryFg} />
          ) : (
            <Text style={styles.submitText}>Accedi</Text>
          )}
        </Pressable>
        <View style={styles.dividerRow}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerText}>oppure</Text>
          <View style={styles.dividerLine} />
        </View>
        <GoogleSignInButton
          label="Accedi con Google"
          loading={googleSubmitting}
          disabled={submitting}
          onPress={handleGoogle}
        />
        <Pressable
          onPress={() => router.push('/forgot-password')}
          style={styles.linkRow}
          accessibilityRole="link"
        >
          <Text style={styles.linkText}>Hai dimenticato la password?</Text>
        </Pressable>
        <Pressable
          onPress={() => router.push('/signup')}
          style={styles.linkRow}
          accessibilityRole="link"
        >
          <Text style={styles.linkText}>Non hai un account? Registrati</Text>
        </Pressable>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  container: { flex: 1, justifyContent: 'center', padding: spacing.lg, gap: spacing.md },
  brand: { alignItems: 'center', marginBottom: spacing.xl, gap: spacing.sm },
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
  field: { gap: spacing.xs },
  label: { fontSize: 13, fontWeight: '500', color: colors.muted },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 16,
    color: colors.fg,
    backgroundColor: colors.bg,
  },
  fieldError: { fontSize: 12, color: colors.danger },
  successBanner: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.primary,
    padding: spacing.md,
    borderRadius: 8,
    borderLeftWidth: 4,
    borderLeftColor: colors.primary,
  },
  successText: { color: colors.primary, fontSize: 13 },
  errorBanner: {
    backgroundColor: colors.dangerBg,
    padding: spacing.md,
    borderRadius: 8,
    borderLeftWidth: 4,
    borderLeftColor: colors.danger,
  },
  errorText: { color: colors.danger, fontSize: 13 },
  submit: {
    marginTop: spacing.md,
    backgroundColor: colors.primary,
    paddingVertical: spacing.md,
    borderRadius: 8,
    alignItems: 'center',
  },
  submitPressed: { opacity: 0.8 },
  submitDisabled: { backgroundColor: colors.muted },
  submitText: { color: colors.primaryFg, fontSize: 16, fontWeight: '600' },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.border },
  dividerText: { color: colors.muted, fontSize: 13 },
  linkRow: { alignItems: 'center', padding: spacing.sm },
  linkText: { color: colors.primary, fontSize: 14 },
});
