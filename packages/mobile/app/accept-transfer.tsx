import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useAcceptTransfer, useTransferPreview } from '@/queries/transfers';
import { ApiError } from '@/lib/api-error';
import { mapErrorToUserMessage } from '@/lib/error-messages';
import { TRANSFER_CODE_RE, validateTransferCode } from '@/lib/validators/transfer';
import { formatDate } from '@/lib/format';
import type { Transfer } from '@/lib/types/transfer';
import { colors, spacing } from '@/theme/colors';

// The preview phase carries the code that found the transfer: accept always
// resends exactly that capability, independent of the DTO's transferCode
// (which is typed nullable for the deferred email_invitation method).
type Phase =
  | { name: 'input' }
  | { name: 'preview'; transfer: Transfer; code: string }
  | { name: 'accepted' };

export default function AcceptTransferScreen() {
  const router = useRouter();
  // claim-vehicle redirects here with the TR code it detected; pre-fill only a
  // well-formed code (mirror of the GO-code prefill in claim-vehicle.tsx).
  const { code: codeParam } = useLocalSearchParams<{ code?: string }>();
  const normalizedParam =
    typeof codeParam === 'string' ? codeParam.trim().toUpperCase() : undefined;
  const initialCode =
    normalizedParam && TRANSFER_CODE_RE.test(normalizedParam) ? normalizedParam : '';

  const [code, setCode] = useState(initialCode);
  const [phase, setPhase] = useState<Phase>({ name: 'input' });
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [banner, setBanner] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const preview = useTransferPreview();
  const accept = useAcceptTransfer();

  async function onVerify() {
    if (submitting) return;
    const normalized = code.trim().toUpperCase();
    const err = validateTransferCode(normalized);
    setFieldError(err);
    if (err) return;
    setBanner(null);
    setSubmitting(true);
    try {
      const t = await preview.mutateAsync(normalized);
      setPhase({ name: 'preview', transfer: t, code: normalized });
    } catch (e) {
      setBanner(mapErrorToUserMessage(e instanceof ApiError ? e.code : undefined));
    } finally {
      setSubmitting(false);
    }
  }

  async function onAccept(codeToAccept: string) {
    if (submitting) return;
    setBanner(null);
    setSubmitting(true);
    try {
      await accept.mutateAsync(codeToAccept);
      setPhase({ name: 'accepted' });
    } catch (e) {
      setBanner(mapErrorToUserMessage(e instanceof ApiError ? e.code : undefined));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: 'Accetta trasferimento' }} />
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
      >
        {banner ? (
          <View style={styles.errorBanner} accessibilityRole="alert">
            <Text style={styles.errorText}>{banner}</Text>
          </View>
        ) : null}

        {phase.name === 'input' ? (
          <>
            <View style={styles.field}>
              <Text style={styles.label}>Codice trasferimento</Text>
              <TextInput
                testID="transfer-code-input"
                style={styles.input}
                value={code}
                onChangeText={setCode}
                placeholder="TR-XXXX-XXXX"
                autoCapitalize="characters"
                autoCorrect={false}
                autoComplete="off"
                editable={!submitting}
              />
              <Text style={styles.hint}>Te lo fornisce chi ti sta cedendo il veicolo.</Text>
              {fieldError ? <Text style={styles.fieldError}>{fieldError}</Text> : null}
            </View>
            <Pressable
              onPress={() => void onVerify()}
              accessibilityRole="button"
              disabled={submitting}
              style={({ pressed }) => [
                styles.primaryBtn,
                pressed && styles.pressed,
                submitting && styles.disabled,
              ]}
            >
              {submitting ? (
                <ActivityIndicator color={colors.primaryFg} />
              ) : (
                <Text style={styles.primaryBtnText}>Verifica</Text>
              )}
            </Pressable>
          </>
        ) : null}

        {phase.name === 'preview' ? (
          <>
            <Text style={styles.sectionTitle}>Stai per ricevere</Text>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>
                {phase.transfer.vehicle.make} {phase.transfer.vehicle.model}
              </Text>
              <Text style={styles.cardPlate}>{phase.transfer.vehicle.plate}</Text>
            </View>
            <Text style={styles.hint}>Scade il {formatDate(phase.transfer.expiresAt)}.</Text>
            <Pressable
              onPress={() => void onAccept(phase.code)}
              accessibilityRole="button"
              disabled={submitting}
              style={({ pressed }) => [
                styles.primaryBtn,
                pressed && styles.pressed,
                submitting && styles.disabled,
              ]}
            >
              {submitting ? (
                <ActivityIndicator color={colors.primaryFg} />
              ) : (
                <Text style={styles.primaryBtnText}>Accetta</Text>
              )}
            </Pressable>
            <Pressable
              onPress={() => {
                setBanner(null);
                setPhase({ name: 'input' });
              }}
              accessibilityRole="button"
              disabled={submitting}
              style={styles.cancel}
            >
              <Text style={styles.cancelText}>Indietro</Text>
            </Pressable>
          </>
        ) : null}

        {phase.name === 'accepted' ? (
          <>
            <Text style={styles.sectionTitle}>Richiesta inviata</Text>
            <Text style={styles.outcome}>
              In attesa della conferma del venditore. Il veicolo comparirà tra i tuoi veicoli quando
              il venditore confermerà il passaggio.
            </Text>
            <Pressable
              onPress={() => router.replace('/')}
              accessibilityRole="button"
              style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
            >
              <Text style={styles.primaryBtnText}>Fine</Text>
            </Pressable>
          </>
        ) : null}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  body: { padding: spacing.lg, gap: spacing.md },
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
  fieldError: { fontSize: 12, color: colors.danger },
  errorBanner: {
    backgroundColor: colors.dangerBg,
    padding: spacing.md,
    borderRadius: 8,
    borderLeftWidth: 4,
    borderLeftColor: colors.danger,
  },
  errorText: { color: colors.danger, fontSize: 13 },
  sectionTitle: { fontSize: 18, fontWeight: '700', color: colors.fg },
  card: { backgroundColor: colors.mutedBg, padding: spacing.md, borderRadius: 8, gap: spacing.xs },
  cardTitle: { fontSize: 18, fontWeight: '700', color: colors.fg },
  cardPlate: { fontSize: 15, color: colors.fg },
  outcome: { fontSize: 14, color: colors.fg, lineHeight: 20 },
  primaryBtn: {
    marginTop: spacing.sm,
    backgroundColor: colors.primary,
    paddingVertical: spacing.md,
    borderRadius: 8,
    alignItems: 'center',
  },
  primaryBtnText: { color: colors.primaryFg, fontSize: 16, fontWeight: '600' },
  pressed: { opacity: 0.8 },
  disabled: { backgroundColor: colors.muted },
  cancel: { alignItems: 'center', padding: spacing.sm },
  cancelText: { color: colors.primary, fontSize: 14 },
});
