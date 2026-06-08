import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { validateDisputeForm, type DisputeFormErrors } from '@/lib/validators/dispute';
import { REASON_CATEGORY_LABELS, REASON_CATEGORY_ORDER } from '@/lib/dispute-labels';
import { mapErrorToUserMessage } from '@/lib/error-messages';
import type { CreateDisputeBody, DisputeReasonCategory } from '@/lib/types/intervention';
import { colors, spacing } from '@/theme/colors';

export type DisputeFormResult = { ok: true } | { ok: false; code: string; message?: string };

type Props = {
  onSubmit: (body: CreateDisputeBody) => Promise<DisputeFormResult>;
  onCancel: () => void;
};

export function DisputeForm({ onSubmit, onCancel }: Props) {
  const [reasonCategory, setReasonCategory] = useState<DisputeReasonCategory | null>(null);
  const [description, setDescription] = useState('');
  const [errors, setErrors] = useState<DisputeFormErrors>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    if (submitting) return;
    const v = validateDisputeForm({ reasonCategory, description });
    setErrors(v);
    if (Object.keys(v).length > 0) return;
    setBanner(null);
    setSubmitting(true);
    try {
      const result = await onSubmit({
        reasonCategory: reasonCategory!,
        description: description.trim(),
      });
      if (result.ok) return; // parent navigates away
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
        <Text style={styles.label}>Motivazione</Text>
        {REASON_CATEGORY_ORDER.map((cat) => {
          const selected = reasonCategory === cat;
          return (
            <Pressable
              key={cat}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              onPress={() => !submitting && setReasonCategory(cat)}
              style={[styles.option, selected && styles.optionSelected]}
            >
              <Text style={[styles.optionText, selected && styles.optionTextSelected]}>
                {REASON_CATEGORY_LABELS[cat]}
              </Text>
            </Pressable>
          );
        })}
        {errors.reasonCategory ? (
          <Text style={styles.fieldError}>{errors.reasonCategory}</Text>
        ) : null}
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Descrizione ({description.trim().length}/2000)</Text>
        <TextInput
          style={[styles.input, styles.multiline]}
          value={description}
          onChangeText={setDescription}
          placeholder="Descrivi il motivo della contestazione"
          multiline
          numberOfLines={6}
          editable={!submitting}
        />
        {errors.description ? <Text style={styles.fieldError}>{errors.description}</Text> : null}
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
          <Text style={styles.submitText}>Invia contestazione</Text>
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
  option: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  optionSelected: { borderColor: colors.primary, backgroundColor: colors.dangerBg },
  optionText: { fontSize: 15, color: colors.fg },
  optionTextSelected: { fontWeight: '600' },
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
  multiline: { minHeight: 120, textAlignVertical: 'top' },
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
