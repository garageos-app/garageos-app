import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { validateSignupForm, type SignupFormErrors } from '@/lib/validators/signup';
import { mapErrorToUserMessage } from '@/lib/error-messages';
import { colors, spacing } from '@/theme/colors';

export type SignupFormPayload = {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
};

export type SignupFormSubmitResult = { ok: true } | { ok: false; code: string; message?: string };

type SignupFormProps = {
  onSubmit: (payload: SignupFormPayload) => Promise<SignupFormSubmitResult>;
  onNavigateLogin: () => void;
};

export function SignupForm({ onSubmit, onNavigateLogin }: SignupFormProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<SignupFormErrors>({});
  const [banner, setBanner] = useState<string | null>(null);

  async function handleSubmit() {
    if (submitting) return;
    // Trim email and names before validation so leading/trailing whitespace
    // doesn't produce spurious format errors (user still sees raw input until submit).
    const v = validateSignupForm({
      email: email.trim(),
      password,
      confirmPassword,
      firstName: firstName.trim(),
      lastName: lastName.trim(),
    });
    setErrors(v);
    setBanner(null);
    if (Object.keys(v).length > 0) return;

    setSubmitting(true);
    try {
      const payload: SignupFormPayload = {
        email: email.trim().toLowerCase(),
        password,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
      };
      const result = await onSubmit(payload);
      if (result.ok) return; // parent navigates away
      const message = mapErrorToUserMessage(result.code);
      // password_policy_violation → inline error under password field
      if (result.code === 'auth.signup.password_policy_violation') {
        setErrors({ password: message });
        return;
      }
      setBanner(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.brand}>
        <View style={styles.logo}>
          <Text style={styles.logoText}>G</Text>
        </View>
        <Text style={styles.wordmark}>GarageOS</Text>
      </View>
      {banner ? (
        <View style={styles.errorBanner} accessibilityRole="alert">
          <Text style={styles.errorText}>{banner}</Text>
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
        {errors.email ? <Text style={styles.fieldError}>{errors.email}</Text> : null}
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

      <View style={styles.field}>
        <Text style={styles.label}>Nome</Text>
        <TextInput
          style={styles.input}
          value={firstName}
          onChangeText={setFirstName}
          placeholder="Nome"
          autoCapitalize="words"
          autoComplete="given-name"
          editable={!submitting}
        />
        {errors.firstName ? <Text style={styles.fieldError}>{errors.firstName}</Text> : null}
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Cognome</Text>
        <TextInput
          style={styles.input}
          value={lastName}
          onChangeText={setLastName}
          placeholder="Cognome"
          autoCapitalize="words"
          autoComplete="family-name"
          editable={!submitting}
        />
        {errors.lastName ? <Text style={styles.fieldError}>{errors.lastName}</Text> : null}
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
          <Text style={styles.submitText}>Registrati</Text>
        )}
      </Pressable>

      <Pressable
        onPress={onNavigateLogin}
        style={styles.linkRow}
        accessibilityRole="link"
        disabled={submitting}
      >
        <Text style={styles.linkText}>Hai già un account? Accedi</Text>
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
  linkRow: { alignItems: 'center', padding: spacing.sm },
  linkText: { color: colors.primary, fontSize: 14 },
});
