import { useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { validateClaimForm } from '@/lib/validators/claimVehicle';
import { mapErrorToUserMessage } from '@/lib/error-messages';
import { QrScanner } from '@/components/QrScanner';
import { colors, spacing } from '@/theme/colors';

export type ClaimVehicleFormResult = { ok: true } | { ok: false; code: string; message?: string };

type Props = {
  onSubmit: (garageCode: string) => Promise<ClaimVehicleFormResult>;
  onCancel: () => void;
  initialCode?: string;
};

export function ClaimVehicleForm({ onSubmit, onCancel, initialCode }: Props) {
  const [code, setCode] = useState(initialCode ?? '');
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [banner, setBanner] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showScanner, setShowScanner] = useState(false);

  function handleScanned(scanned: string) {
    setCode(scanned);
    setShowScanner(false);
    setFieldError(undefined);
    setBanner(null);
  }

  async function handleSubmit() {
    if (submitting) return;
    const normalized = code.trim().toUpperCase();
    const err = validateClaimForm(normalized);
    setFieldError(err);
    if (err) return;
    setBanner(null);

    setSubmitting(true);
    try {
      const result = await onSubmit(normalized);
      if (result.ok) return; // parent navigates away
      setBanner(result.message ?? mapErrorToUserMessage(result.code));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View style={styles.container}>
      {/* The form lives inside a ScrollView; the QrScanner root is
          absoluteFill, which collapses to 0 height as an in-flow child of
          scroll content (blank screen). A full-screen Modal escapes that
          layout and gives the scanner the whole viewport. */}
      <Modal
        visible={showScanner}
        animationType="slide"
        onRequestClose={() => setShowScanner(false)}
      >
        {showScanner ? (
          <QrScanner onScanned={handleScanned} onCancel={() => setShowScanner(false)} />
        ) : null}
      </Modal>

      {banner ? (
        <View style={styles.errorBanner} accessibilityRole="alert">
          <Text style={styles.errorText}>{banner}</Text>
        </View>
      ) : null}

      <View style={styles.field}>
        <Text style={styles.label}>Codice GarageOS</Text>
        <TextInput
          style={styles.input}
          value={code}
          onChangeText={setCode}
          placeholder="GO-NNN-AAAA"
          autoCapitalize="characters"
          autoCorrect={false}
          autoComplete="off"
          editable={!submitting}
        />
        <Text style={styles.hint}>
          {"Lo trovi sul tag adesivo del veicolo o nell'email dell'officina."}
        </Text>
        <Pressable
          onPress={() => setShowScanner(true)}
          accessibilityRole="button"
          disabled={submitting}
          style={styles.scanButton}
        >
          <Ionicons name="qr-code-outline" size={18} color={colors.primary} />
          <Text style={styles.scanButtonText}>Scansiona QR</Text>
        </Pressable>
        {fieldError ? <Text style={styles.fieldError}>{fieldError}</Text> : null}
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
          <Text style={styles.submitText}>Aggiungi</Text>
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
  hint: { fontSize: 12, color: colors.muted },
  scanButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
  },
  scanButtonText: { color: colors.primary, fontSize: 14, fontWeight: '600' },
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
