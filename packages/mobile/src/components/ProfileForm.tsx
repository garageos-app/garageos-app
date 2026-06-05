import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { validateProfileForm, type ProfileFormErrors } from '@/lib/validators/profile';
import { mapErrorToUserMessage } from '@/lib/error-messages';
import type { UpdateMeProfileBody } from '@/lib/types/profile';
import { colors, spacing } from '@/theme/colors';

export type ProfileFormResult = { ok: true } | { ok: false; code: string; message?: string };

type Props = {
  initial: { firstName: string; lastName: string; phone: string };
  onSubmit: (body: UpdateMeProfileBody) => Promise<ProfileFormResult>;
  onCancel: () => void;
};

export function ProfileForm({ initial, onSubmit, onCancel }: Props) {
  const [firstName, setFirstName] = useState(initial.firstName);
  const [lastName, setLastName] = useState(initial.lastName);
  const [phone, setPhone] = useState(initial.phone);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<ProfileFormErrors>({});
  const [banner, setBanner] = useState<string | null>(null);

  async function handleSubmit() {
    if (submitting) return;
    const v = validateProfileForm({ firstName, lastName, phone });
    setErrors(v);
    if (Object.keys(v).length > 0) return;
    setBanner(null);
    const body: UpdateMeProfileBody = {
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      phone: phone.trim() === '' ? null : phone.trim(),
    };
    setSubmitting(true);
    try {
      const result = await onSubmit(body);
      if (result.ok) return; // parent leaves edit mode
      setBanner(result.message ?? mapErrorToUserMessage(result.code));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View style={styles.container}>
      {banner ? (
        <View style={styles.errorBanner} accessibilityRole="alert">
          <Text style={styles.errorText}>{banner}</Text>
        </View>
      ) : null}

      <View style={styles.field}>
        <Text style={styles.label}>Nome</Text>
        <TextInput
          style={styles.input}
          value={firstName}
          onChangeText={setFirstName}
          placeholder="Nome"
          autoCapitalize="words"
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
          editable={!submitting}
        />
        {errors.lastName ? <Text style={styles.fieldError}>{errors.lastName}</Text> : null}
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Telefono</Text>
        <TextInput
          style={styles.input}
          value={phone}
          onChangeText={setPhone}
          placeholder="Telefono"
          keyboardType="phone-pad"
          editable={!submitting}
        />
        {errors.phone ? <Text style={styles.fieldError}>{errors.phone}</Text> : null}
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
          <Text style={styles.submitText}>Salva</Text>
        )}
      </Pressable>

      <Pressable
        onPress={onCancel}
        accessibilityRole="button"
        disabled={submitting}
        style={styles.cancel}
      >
        <Text style={styles.cancelText}>Annulla</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.md, padding: spacing.lg },
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
  cancel: { alignItems: 'center', padding: spacing.sm },
  cancelText: { color: colors.primary, fontSize: 14 },
});
