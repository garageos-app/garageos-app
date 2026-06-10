import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useInitiateTransfer } from '@/queries/transfers';
import { ErrorState } from '@/components/ErrorState';
import { ApiError } from '@/lib/api-error';
import { mapErrorToUserMessage } from '@/lib/error-messages';
import { transferShareMessage } from '@/lib/transfer-labels';
import { formatDate } from '@/lib/format';
import type { Transfer } from '@/lib/types/transfer';
import { colors, spacing } from '@/theme/colors';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Phase = { name: 'summary' } | { name: 'code'; transfer: Transfer };

export default function NewTransferScreen() {
  const params = useLocalSearchParams<{ vehicleId?: string; vehicleLabel?: string }>();
  const vehicleId =
    typeof params.vehicleId === 'string' && UUID_RE.test(params.vehicleId) ? params.vehicleId : '';
  const vehicleLabel =
    typeof params.vehicleLabel === 'string' && params.vehicleLabel
      ? params.vehicleLabel
      : 'Questo veicolo';
  const router = useRouter();
  const initiate = useInitiateTransfer();
  const [phase, setPhase] = useState<Phase>({ name: 'summary' });
  const [banner, setBanner] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!vehicleId) {
    return <ErrorState message="Veicolo non valido." />;
  }

  async function onStart() {
    if (submitting) return;
    setBanner(null);
    setSubmitting(true);
    try {
      const t = await initiate.mutateAsync({ vehicleId });
      setPhase({ name: 'code', transfer: t });
    } catch (e) {
      setBanner(mapErrorToUserMessage(e instanceof ApiError ? e.code : undefined));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: 'Trasferisci proprietà' }} />
      <ScrollView style={styles.container} contentContainerStyle={styles.body}>
        {banner ? (
          <View style={styles.errorBanner} accessibilityRole="alert">
            <Text style={styles.errorText}>{banner}</Text>
          </View>
        ) : null}

        {phase.name === 'summary' ? (
          <>
            <View style={styles.card}>
              <Text style={styles.label}>Veicolo</Text>
              <Text style={styles.value}>{vehicleLabel}</Text>
            </View>
            <View style={styles.warningBox}>
              <Text style={styles.warningText}>
                {
                  'Riceverai un codice da comunicare al nuovo proprietario, valido 7 giorni. Il veicolo resta di tua proprietà finché non confermerai il passaggio.'
                }
              </Text>
            </View>
            <Pressable
              onPress={() => void onStart()}
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
                <Text style={styles.primaryBtnText}>Avvia trasferimento</Text>
              )}
            </Pressable>
            <Pressable
              onPress={() => router.back()}
              accessibilityRole="button"
              disabled={submitting}
              style={styles.cancel}
            >
              <Text style={styles.cancelText}>Annulla</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={styles.codeTitle}>Codice generato</Text>
            <Text style={styles.code} testID="transfer-code">
              {phase.transfer.transferCode}
            </Text>
            <Text style={styles.hint}>
              {'Comunica questo codice al nuovo proprietario. Scade il '}
              {formatDate(phase.transfer.expiresAt)}
              {'.'}
            </Text>
            <Pressable
              onPress={() => void Share.share({ message: transferShareMessage(phase.transfer) })}
              accessibilityRole="button"
              style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
            >
              <Text style={styles.primaryBtnText}>Condividi</Text>
            </Pressable>
            <Pressable
              onPress={() => router.replace(`/transfers/${phase.transfer.id}`)}
              accessibilityRole="button"
              style={styles.cancel}
            >
              <Text style={styles.cancelText}>Fine</Text>
            </Pressable>
          </>
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  body: { padding: spacing.lg, gap: spacing.md },
  card: { backgroundColor: colors.mutedBg, padding: spacing.md, borderRadius: 8, gap: spacing.xs },
  label: { fontSize: 12, color: colors.muted, textTransform: 'uppercase', letterSpacing: 0.5 },
  value: { fontSize: 16, color: colors.fg },
  warningBox: { backgroundColor: colors.warningBg, padding: spacing.md, borderRadius: 8 },
  warningText: { color: colors.warningFg, fontSize: 13, lineHeight: 18 },
  errorBanner: {
    backgroundColor: colors.dangerBg,
    padding: spacing.md,
    borderRadius: 8,
    borderLeftWidth: 4,
    borderLeftColor: colors.danger,
  },
  errorText: { color: colors.danger, fontSize: 13 },
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
  codeTitle: { fontSize: 16, fontWeight: '600', color: colors.fg, textAlign: 'center' },
  code: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.fg,
    textAlign: 'center',
    letterSpacing: 2,
    paddingVertical: spacing.md,
    backgroundColor: colors.mutedBg,
    borderRadius: 8,
    overflow: 'hidden',
  },
  hint: { fontSize: 13, color: colors.muted, textAlign: 'center' },
});
