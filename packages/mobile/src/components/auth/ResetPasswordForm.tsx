import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { validateResetPassword, type ResetPasswordErrors } from '@/lib/validators/resetPassword';
import { mapErrorToUserMessage } from '@/lib/error-messages';
import { colors, spacing } from '@/theme/colors';

const COOLDOWN_SECONDS = 60;

export type ResetPasswordPayload = {
  email: string;
  code: string;
  newPassword: string;
};

export type ResetPasswordFormResult = { ok: true } | { ok: false; code: string; message?: string };

type Props = {
  initialEmail: string | null;
  onSubmit: (payload: ResetPasswordPayload) => Promise<ResetPasswordFormResult>;
  onResend: (email: string) => Promise<ResetPasswordFormResult>;
  onNavigateBack: () => void;
};

export function ResetPasswordForm({ initialEmail, onSubmit, onResend, onNavigateBack }: Props) {
  const [email, setEmail] = useState(initialEmail ?? '');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [errors, setErrors] = useState<ResetPasswordErrors>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const [resendFeedback, setResendFeedback] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const emailHidden = initialEmail !== null;

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

  async function handleSubmit() {
    if (submitting) return;
    const trimmedEmail = (emailHidden ? (initialEmail ?? '') : email).trim().toLowerCase();
    const v = validateResetPassword({
      email: trimmedEmail,
      code: code.trim(),
      password,
      confirmPassword,
    });
    setErrors(v);
    if (Object.keys(v).length > 0) return;
    setBanner(null);
    setSubmitting(true);
    try {
      const result = await onSubmit({
        email: trimmedEmail,
        code: code.trim(),
        newPassword: password,
      });
      if (result.ok) return;
      // InvalidPasswordException in reset context = policy violation under
      // the password field, NOT a banner (the global mapping is shared with
      // login and reads as "Email o password non corretti"). Mirror of the
      // signup `auth.signup.password_policy_violation` UX from PR #106.
      if (result.code === 'InvalidPasswordException') {
        setErrors({
          password:
            'La password non rispetta i requisiti: almeno 8 caratteri, una lettera minuscola e un numero.',
        });
        return;
      }
      setBanner(mapErrorToUserMessage(result.code));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResend() {
    if (resending || cooldown > 0) return;
    const targetEmail = (emailHidden ? (initialEmail ?? '') : email).trim().toLowerCase();
    if (!targetEmail) {
      setResendFeedback('Inserisci prima la tua email.');
      return;
    }
    setResending(true);
    setResendFeedback(null);
    try {
      const result = await onResend(targetEmail);
      if (result.ok) {
        setResendFeedback('Codice inviato di nuovo.');
        startCooldown();
      } else {
        setResendFeedback(mapErrorToUserMessage(result.code));
      }
    } finally {
      setResending(false);
    }
  }

  const resendDisabled = resending || cooldown > 0;
  const resendLabel =
    cooldown > 0 ? `Invia di nuovo il codice (${cooldown}s)` : 'Invia di nuovo il codice';

  return (
    <View style={styles.container}>
      <View style={styles.brand}>
        <View style={styles.logo}>
          <Text style={styles.logoText}>G</Text>
        </View>
        <Text style={styles.wordmark}>GarageOS</Text>
      </View>

      <Text style={styles.h1}>Reimposta password</Text>
      <Text style={styles.body}>
        Inserisci il codice ricevuto via email e scegli una nuova password.
      </Text>

      {banner ? (
        <View style={styles.errorBanner} accessibilityRole="alert">
          <Text style={styles.errorText}>{banner}</Text>
        </View>
      ) : null}

      {!emailHidden ? (
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
          {errors.email ? <Text style={styles.fieldError}>{errors.email}</Text> : null}
        </View>
      ) : null}

      <View style={styles.field}>
        <Text style={styles.label}>Codice</Text>
        <TextInput
          style={styles.input}
          value={code}
          onChangeText={setCode}
          placeholder="Codice"
          keyboardType="number-pad"
          maxLength={6}
          autoComplete="one-time-code"
          editable={!submitting}
        />
        {errors.code ? <Text style={styles.fieldError}>{errors.code}</Text> : null}
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Nuova password</Text>
        <TextInput
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          placeholder="Nuova password"
          secureTextEntry
          autoCapitalize="none"
          autoComplete="password-new"
          editable={!submitting}
        />
        <Text style={styles.helper}>Almeno 8 caratteri, una lettera minuscola, un numero</Text>
        {errors.password ? <Text style={styles.fieldError}>{errors.password}</Text> : null}
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Conferma password</Text>
        <TextInput
          style={styles.input}
          value={confirmPassword}
          onChangeText={setConfirmPassword}
          placeholder="Conferma password"
          secureTextEntry
          autoCapitalize="none"
          autoComplete="password-new"
          editable={!submitting}
        />
        {errors.confirmPassword ? (
          <Text style={styles.fieldError}>{errors.confirmPassword}</Text>
        ) : null}
      </View>

      <Pressable
        onPress={handleSubmit}
        accessibilityRole="button"
        disabled={submitting}
        style={({ pressed }) => [
          styles.submit,
          pressed && styles.submitPressed,
          submitting && styles.submitDisabled,
        ]}
      >
        {submitting ? (
          <ActivityIndicator color={colors.primaryFg} />
        ) : (
          <Text style={styles.submitText}>Reimposta password</Text>
        )}
      </Pressable>

      {resendFeedback ? (
        <Text style={styles.feedback} accessibilityLiveRegion="polite">
          {resendFeedback}
        </Text>
      ) : null}

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
        {resending ? (
          <ActivityIndicator color={colors.primary} />
        ) : (
          <Text style={styles.secondaryText}>{resendLabel}</Text>
        )}
      </Pressable>

      <Pressable
        onPress={onNavigateBack}
        style={styles.linkRow}
        accessibilityRole="link"
        disabled={submitting}
      >
        <Text style={styles.linkText}>Torna al login</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.md, padding: spacing.lg },
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
  h1: { fontSize: 22, fontWeight: '700', color: colors.fg, textAlign: 'center' },
  body: { fontSize: 15, color: colors.muted, textAlign: 'center', lineHeight: 22 },
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
  helper: { fontSize: 12, color: colors.muted },
  fieldError: { fontSize: 12, color: colors.danger },
  errorBanner: {
    backgroundColor: colors.dangerBg,
    padding: spacing.md,
    borderRadius: 8,
    borderLeftWidth: 4,
    borderLeftColor: colors.danger,
  },
  errorText: { color: colors.danger, fontSize: 13 },
  feedback: { fontSize: 13, color: colors.muted, textAlign: 'center' },
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
