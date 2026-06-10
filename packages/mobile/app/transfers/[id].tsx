import { Alert, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useConfirmTransfer, useRejectTransfer, useTransfer } from '@/queries/transfers';
import { LoadingState } from '@/components/LoadingState';
import { ErrorState } from '@/components/ErrorState';
import { ApiError } from '@/lib/api-error';
import { mapErrorToUserMessage } from '@/lib/error-messages';
import {
  TRANSFER_STATUS_LABELS,
  transferShareMessage,
  transferStatusTone,
} from '@/lib/transfer-labels';
import { formatDate } from '@/lib/format';
import { colors, spacing } from '@/theme/colors';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function TransferDetailScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = typeof params.id === 'string' && UUID_RE.test(params.id) ? params.id : '';
  const detail = useTransfer(id);
  const confirm = useConfirmTransfer();
  const reject = useRejectTransfer();

  if (!id) return <ErrorState message="Trasferimento non trovato." />;
  if (detail.isLoading) return <LoadingState variant="fullscreen" />;
  if (detail.isError || !detail.data) {
    const code = detail.error instanceof ApiError ? detail.error.code : undefined;
    return <ErrorState message={mapErrorToUserMessage(code)} onRetry={detail.refetch} />;
  }

  const t = detail.data;
  const tone = transferStatusTone(t.status);
  const busy = confirm.isPending || reject.isPending;
  const mutationError = confirm.error ?? reject.error;

  function onCancelTransfer() {
    Alert.alert('Annullare il trasferimento?', 'Il codice non sarà più utilizzabile.', [
      { text: 'No', style: 'cancel' },
      {
        text: 'Annulla trasferimento',
        style: 'destructive',
        onPress: () => reject.mutate({ id }),
      },
    ]);
  }

  function onConfirmTransfer() {
    Alert.alert(
      'Confermare il passaggio?',
      'La proprietà del veicolo passerà definitivamente al nuovo proprietario.',
      [
        { text: 'Annulla', style: 'cancel' },
        { text: 'Conferma', onPress: () => confirm.mutate(id) },
      ],
    );
  }

  function onRejectTransfer() {
    Alert.alert('Rifiutare il trasferimento?', 'Il veicolo resterà di tua proprietà.', [
      { text: 'No', style: 'cancel' },
      { text: 'Rifiuta', style: 'destructive', onPress: () => reject.mutate({ id }) },
    ]);
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: 'Trasferimento' }} />
      <ScrollView style={styles.container} contentContainerStyle={styles.body}>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>
            {t.vehicle.make} {t.vehicle.model}
          </Text>
          <Text style={styles.cardPlate}>{t.vehicle.plate}</Text>
        </View>

        <View
          style={[
            styles.badge,
            tone === 'pending'
              ? styles.badgePending
              : tone === 'done'
                ? styles.badgeDone
                : styles.badgeClosed,
          ]}
        >
          <Text
            style={[
              styles.badgeText,
              tone === 'pending'
                ? styles.badgeTextPending
                : tone === 'done'
                  ? styles.badgeTextDone
                  : styles.badgeTextClosed,
            ]}
          >
            {TRANSFER_STATUS_LABELS[t.status]}
          </Text>
        </View>
        <Text style={styles.meta}>Avviato il {formatDate(t.createdAt)}</Text>

        {mutationError ? (
          <View style={styles.errorBanner} accessibilityRole="alert">
            <Text style={styles.errorText}>
              {mapErrorToUserMessage(
                mutationError instanceof ApiError ? mutationError.code : undefined,
              )}
            </Text>
          </View>
        ) : null}

        {t.status === 'pending_recipient' ? (
          <>
            <Text style={styles.code} testID="transfer-code">
              {t.transferCode ?? '—'}
            </Text>
            <Text style={styles.hint}>
              Comunica questo codice al nuovo proprietario. Scade il {formatDate(t.expiresAt)}.
            </Text>
            <Pressable
              onPress={() => void Share.share({ message: transferShareMessage(t) })}
              accessibilityRole="button"
              disabled={busy}
              style={({ pressed }) => [
                styles.primaryBtn,
                pressed && styles.pressed,
                busy && styles.disabled,
              ]}
            >
              <Text style={styles.primaryBtnText}>Condividi</Text>
            </Pressable>
            <Pressable
              onPress={onCancelTransfer}
              accessibilityRole="button"
              disabled={busy}
              style={({ pressed }) => [
                styles.dangerBtn,
                pressed && styles.pressed,
                busy && styles.disabled,
              ]}
            >
              <Text style={styles.dangerBtnText}>Annulla trasferimento</Text>
            </Pressable>
          </>
        ) : null}

        {t.status === 'pending_seller_confirmation' ? (
          <>
            <Text style={styles.hint}>
              Il nuovo proprietario ha accettato. Conferma per completare il passaggio entro il{' '}
              {formatDate(t.expiresAt)}.
            </Text>
            <Pressable
              onPress={onConfirmTransfer}
              accessibilityRole="button"
              disabled={busy}
              style={({ pressed }) => [
                styles.primaryBtn,
                pressed && styles.pressed,
                busy && styles.disabled,
              ]}
            >
              <Text style={styles.primaryBtnText}>Conferma passaggio</Text>
            </Pressable>
            <Pressable
              onPress={onRejectTransfer}
              accessibilityRole="button"
              disabled={busy}
              style={({ pressed }) => [
                styles.dangerBtn,
                pressed && styles.pressed,
                busy && styles.disabled,
              ]}
            >
              <Text style={styles.dangerBtnText}>Rifiuta</Text>
            </Pressable>
          </>
        ) : null}

        {t.status === 'completed' ? (
          <Text style={styles.meta}>Completato il {formatDate(t.completedAt)}.</Text>
        ) : null}

        {t.status === 'rejected' ? (
          <>
            <Text style={styles.meta}>Trasferimento rifiutato.</Text>
            {t.rejectedReason ? <Text style={styles.meta}>Motivo: {t.rejectedReason}</Text> : null}
          </>
        ) : null}

        {t.status === 'expired' ? (
          <Text style={styles.meta}>Scaduto il {formatDate(t.expiresAt)}.</Text>
        ) : null}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  body: { padding: spacing.lg, gap: spacing.md },
  card: { backgroundColor: colors.mutedBg, padding: spacing.md, borderRadius: 8, gap: spacing.xs },
  cardTitle: { fontSize: 18, fontWeight: '700', color: colors.fg },
  cardPlate: { fontSize: 15, color: colors.fg },
  badge: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  badgePending: { backgroundColor: colors.warningBg },
  badgeDone: { backgroundColor: colors.mutedBg, borderWidth: 1, borderColor: colors.primary },
  badgeClosed: { backgroundColor: colors.dangerBg },
  badgeText: { fontSize: 13, fontWeight: '600' },
  badgeTextPending: { color: colors.warningFg },
  badgeTextDone: { color: colors.primary },
  badgeTextClosed: { color: colors.danger },
  meta: { fontSize: 14, color: colors.muted },
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
  hint: { fontSize: 13, color: colors.muted },
  errorBanner: {
    backgroundColor: colors.dangerBg,
    padding: spacing.md,
    borderRadius: 8,
    borderLeftWidth: 4,
    borderLeftColor: colors.danger,
  },
  errorText: { color: colors.danger, fontSize: 13 },
  primaryBtn: {
    backgroundColor: colors.primary,
    paddingVertical: spacing.md,
    borderRadius: 8,
    alignItems: 'center',
  },
  primaryBtnText: { color: colors.primaryFg, fontSize: 16, fontWeight: '600' },
  dangerBtn: {
    borderWidth: 1,
    borderColor: colors.danger,
    paddingVertical: spacing.md,
    borderRadius: 8,
    alignItems: 'center',
  },
  dangerBtnText: { color: colors.danger, fontSize: 16, fontWeight: '600' },
  pressed: { opacity: 0.8 },
  // Works for both filled and outline buttons (unlike a background swap).
  disabled: { opacity: 0.5 },
});
