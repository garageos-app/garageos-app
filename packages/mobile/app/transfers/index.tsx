import { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useTransfers } from '@/queries/transfers';
import { LoadingState } from '@/components/LoadingState';
import { ErrorState } from '@/components/ErrorState';
import { EmptyState } from '@/components/EmptyState';
import { ApiError } from '@/lib/api-error';
import { mapErrorToUserMessage } from '@/lib/error-messages';
import { TRANSFER_STATUS_LABELS, transferStatusTone } from '@/lib/transfer-labels';
import { formatDate } from '@/lib/format';
import type { Transfer } from '@/lib/types/transfer';
import { colors, spacing } from '@/theme/colors';

export default function TransfersScreen() {
  const router = useRouter();
  const transfers = useTransfers();
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await transfers.refetch();
    } finally {
      setRefreshing(false);
    }
  }, [transfers]);

  if (transfers.isLoading) return <LoadingState variant="fullscreen" />;
  if (transfers.isError) {
    const code = transfers.error instanceof ApiError ? transfers.error.code : undefined;
    return <ErrorState message={mapErrorToUserMessage(code)} onRetry={transfers.refetch} />;
  }

  const items = transfers.data ?? [];

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: 'Trasferimenti' }} />
      <FlatList
        style={styles.container}
        contentContainerStyle={styles.body}
        data={items}
        keyExtractor={(t) => t.id}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
            tintColor={colors.primary}
          />
        }
        ListHeaderComponent={
          <Pressable
            onPress={() => router.push('/accept-transfer')}
            accessibilityRole="button"
            style={({ pressed }) => [styles.receivedBtn, pressed && styles.pressed]}
          >
            <Text style={styles.receivedBtnText}>Hai ricevuto un codice?</Text>
          </Pressable>
        }
        ListEmptyComponent={
          <EmptyState
            title="Nessun trasferimento"
            body="Quando avvierai il passaggio di proprietà di un veicolo lo vedrai qui."
          />
        }
        renderItem={({ item }) => <TransferRow transfer={item} />}
      />
    </>
  );
}

function TransferRow({ transfer }: { transfer: Transfer }) {
  const router = useRouter();
  const tone = transferStatusTone(transfer.status);
  return (
    <Pressable
      testID={`transfer-row-${transfer.id}`}
      onPress={() => router.push(`/transfers/${transfer.id}`)}
      accessibilityRole="button"
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
    >
      <View style={styles.cardTop}>
        <Text style={styles.cardTitle}>
          {transfer.vehicle.make} {transfer.vehicle.model}
        </Text>
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
            {TRANSFER_STATUS_LABELS[transfer.status]}
          </Text>
        </View>
      </View>
      <Text style={styles.cardPlate}>{transfer.vehicle.plate}</Text>
      <Text style={styles.cardDate}>Avviato il {formatDate(transfer.createdAt)}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  body: { padding: spacing.lg, gap: spacing.md },
  receivedBtn: {
    borderWidth: 1,
    borderColor: colors.primary,
    paddingVertical: spacing.sm,
    borderRadius: 8,
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  receivedBtnText: { color: colors.primary, fontSize: 14, fontWeight: '600' },
  pressed: { opacity: 0.7 },
  card: {
    backgroundColor: colors.mutedBg,
    padding: spacing.md,
    borderRadius: 8,
    gap: spacing.xs,
    marginBottom: spacing.sm,
  },
  cardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
  },
  cardTitle: { fontSize: 16, fontWeight: '600', color: colors.fg, flexShrink: 1 },
  cardPlate: { fontSize: 14, color: colors.fg },
  cardDate: { fontSize: 12, color: colors.muted },
  badge: { borderRadius: 999, paddingHorizontal: spacing.sm, paddingVertical: 2 },
  badgePending: { backgroundColor: colors.warningBg },
  badgeDone: { backgroundColor: colors.mutedBg, borderWidth: 1, borderColor: colors.primary },
  badgeClosed: { backgroundColor: colors.dangerBg },
  badgeText: { fontSize: 11, fontWeight: '600' },
  badgeTextPending: { color: colors.warningFg },
  badgeTextDone: { color: colors.primary },
  badgeTextClosed: { color: colors.danger },
});
