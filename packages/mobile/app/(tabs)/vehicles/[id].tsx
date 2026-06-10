import { useCallback, useState } from 'react';
import { FlatList, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Pressable } from 'react-native';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import { useMeVehicleDetail } from '@/queries/meVehicles';
import { useMeVehicleTimeline } from '@/queries/meVehicleTimeline';
import { useMeDeadlines, deadlinesForVehicle } from '@/queries/meDeadlines';
import { useMeVehicleAccessLog } from '@/queries/meVehicleAccessLog';
import { DeadlineRow } from '@/components/DeadlineRow';
import { AccessLogTab } from '@/components/AccessLogTab';
import { LoadingState } from '@/components/LoadingState';
import { ErrorState } from '@/components/ErrorState';
import { EmptyState } from '@/components/EmptyState';
import { TimelineRow } from '@/components/TimelineRow';
import { VehicleHistoryExportButton } from '@/components/VehicleHistoryExportButton';
import { VehicleTransferSection } from '@/components/VehicleTransferSection';
import { ApiError } from '@/lib/api-error';
import { mapErrorToUserMessage } from '@/lib/error-messages';
import { formatDate } from '@/lib/format';
import { colors, spacing } from '@/theme/colors';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function VehicleDetailScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const validId = UUID_RE.test(id) ? id : '';
  const [tab, setTab] = useState<'history' | 'deadlines' | 'tech' | 'access'>('history');
  const [refreshing, setRefreshing] = useState(false);

  const detail = useMeVehicleDetail(validId);
  const timeline = useMeVehicleTimeline(validId);
  const deadlines = useMeDeadlines();
  const accessLog = useMeVehicleAccessLog(validId, { enabled: tab === 'access' });

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const tasks: Promise<unknown>[] = [detail.refetch(), timeline.refetch(), deadlines.refetch()];
      if (tab === 'access') tasks.push(accessLog.refetch());
      await Promise.all(tasks);
    } finally {
      setRefreshing(false);
    }
  }, [detail, timeline, deadlines, accessLog, tab]);

  if (!validId) {
    return <ErrorState message="Veicolo non trovato o non più di tua proprietà." />;
  }

  if (detail.isLoading) return <LoadingState variant="fullscreen" />;

  if (detail.isError) {
    const code = detail.error instanceof ApiError ? detail.error.code : undefined;
    return <ErrorState message={mapErrorToUserMessage(code)} onRetry={detail.refetch} />;
  }

  const v = detail.data!.vehicle;
  const headerTitle = `${v.make} ${v.model}`;

  return (
    <>
      <Stack.Screen options={{ title: headerTitle }} />
      <ScrollView
        style={styles.container}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
          />
        }
      >
        <View style={styles.header}>
          <View style={styles.iconWrap}>
            <Text style={styles.icon}>🚗</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>{headerTitle}</Text>
            <Text style={styles.plate}>{v.plate}</Text>
            {v.year ? <Text style={styles.subtle}>Anno {v.year}</Text> : null}
            <Text style={styles.subtle}>Codice: {v.garageCode}</Text>
          </View>
        </View>

        <View style={styles.tabsRow}>
          <Pressable
            onPress={() => setTab('history')}
            style={[styles.tabButton, tab === 'history' && styles.tabButtonActive]}
            accessibilityRole="button"
          >
            <Text style={[styles.tabText, tab === 'history' && styles.tabTextActive]}>Storico</Text>
          </Pressable>
          <Pressable
            onPress={() => setTab('deadlines')}
            style={[styles.tabButton, tab === 'deadlines' && styles.tabButtonActive]}
            accessibilityRole="button"
          >
            <Text style={[styles.tabText, tab === 'deadlines' && styles.tabTextActive]}>
              Scadenze
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setTab('tech')}
            style={[styles.tabButton, tab === 'tech' && styles.tabButtonActive]}
            accessibilityRole="button"
          >
            <Text style={[styles.tabText, tab === 'tech' && styles.tabTextActive]}>
              Dati tecnici
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setTab('access')}
            style={[styles.tabButton, tab === 'access' && styles.tabButtonActive]}
            accessibilityRole="button"
          >
            <Text style={[styles.tabText, tab === 'access' && styles.tabTextActive]}>Accessi</Text>
          </Pressable>
        </View>

        {tab === 'history' ? (
          <HistoryTab vehicleId={validId} timeline={timeline} />
        ) : tab === 'deadlines' ? (
          <DeadlinesTab vehicleId={validId} deadlines={deadlines} />
        ) : tab === 'tech' ? (
          <TechTab vehicle={v} />
        ) : (
          <AccessLogTab
            entries={accessLog.data ?? []}
            isLoading={accessLog.isLoading}
            isError={accessLog.isError}
            errorCode={accessLog.error instanceof ApiError ? accessLog.error.code : undefined}
            onRetry={accessLog.refetch}
            hasNextPage={accessLog.hasNextPage}
            isFetchingNextPage={accessLog.isFetchingNextPage}
            onLoadMore={() => {
              void accessLog.fetchNextPage();
            }}
          />
        )}
      </ScrollView>
    </>
  );
}

function HistoryTab({
  vehicleId,
  timeline,
}: {
  vehicleId: string;
  timeline: ReturnType<typeof useMeVehicleTimeline>;
}) {
  const router = useRouter();
  if (timeline.isLoading) return <LoadingState variant="list" />;
  if (timeline.isError) {
    const code = timeline.error instanceof ApiError ? timeline.error.code : undefined;
    return <ErrorState message={mapErrorToUserMessage(code)} onRetry={timeline.refetch} />;
  }
  const items = timeline.data?.data ?? [];
  return (
    <View>
      <Pressable
        style={styles.addBtn}
        accessibilityRole="button"
        onPress={() =>
          router.push({ pathname: '/private-interventions/new', params: { vehicleId } })
        }
      >
        <Text style={styles.addBtnText}>+ Aggiungi intervento privato</Text>
      </Pressable>
      {items.length === 0 ? (
        <EmptyState
          title="Nessun intervento"
          body="Non ci sono ancora interventi registrati per questo veicolo."
        />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(it) => `${it.kind}-${it.id}`}
          renderItem={({ item }) => (
            <TimelineRow
              item={item}
              onPress={() =>
                router.push(
                  item.kind === 'private_intervention'
                    ? `/private-interventions/${item.id}`
                    : `/interventions/${item.id}`,
                )
              }
            />
          )}
          scrollEnabled={false}
        />
      )}
    </View>
  );
}

function DeadlinesTab({
  vehicleId,
  deadlines,
}: {
  vehicleId: string;
  deadlines: ReturnType<typeof useMeDeadlines>;
}) {
  if (deadlines.isLoading) return <LoadingState variant="list" />;
  if (deadlines.isError) {
    const code = deadlines.error instanceof ApiError ? deadlines.error.code : undefined;
    return <ErrorState message={mapErrorToUserMessage(code)} onRetry={deadlines.refetch} />;
  }
  const items = deadlinesForVehicle(deadlines.data, vehicleId);
  if (items.length === 0) {
    return (
      <EmptyState title="Nessuna scadenza" body="Non hai scadenze aperte per questo veicolo." />
    );
  }
  return (
    <FlatList
      data={items}
      keyExtractor={(d) => d.id}
      renderItem={({ item }) => <DeadlineRow deadline={item} hideVehicle />}
      scrollEnabled={false}
    />
  );
}

function TechTab({
  vehicle,
}: {
  vehicle: NonNullable<ReturnType<typeof useMeVehicleDetail>['data']>['vehicle'];
}) {
  const rows: Array<[string, string]> = [
    ['Targa', vehicle.plate],
    ['Codice GarageOS', vehicle.garageCode],
    ['VIN', vehicle.vin],
    ['Marca', vehicle.make],
    ['Modello', vehicle.model],
    ['Versione', vehicle.version ?? '—'],
    ['Anno', vehicle.year ? String(vehicle.year) : '—'],
    ['Data immatricolazione', formatDate(vehicle.registrationDate)],
    ['Tipo', vehicle.vehicleType],
    ['Alimentazione', vehicle.fuelType],
    ['Cilindrata', vehicle.engineDisplacement ? `${vehicle.engineDisplacement} cc` : '—'],
    ['Potenza', vehicle.powerKw ? `${vehicle.powerKw} kW` : '—'],
    ['Colore', vehicle.color ?? '—'],
    ['Certificato il', formatDate(vehicle.certifiedAt?.slice(0, 10))],
  ];
  return (
    <View style={styles.techList}>
      {rows.map(([label, value]) => (
        <View key={label} style={styles.techRow}>
          <Text style={styles.techLabel}>{label}</Text>
          <Text style={styles.techValue}>{value}</Text>
        </View>
      ))}
      <View style={styles.exportSection}>
        <VehicleHistoryExportButton vehicleId={vehicle.id} />
      </View>
      <View style={styles.exportSection}>
        <VehicleTransferSection
          vehicleId={vehicle.id}
          vehicleLabel={`${vehicle.make} ${vehicle.model} · ${vehicle.plate}`}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  addBtn: {
    margin: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.primary,
    alignItems: 'center',
  },
  addBtnText: { color: colors.primary, fontSize: 14, fontWeight: '600' },
  header: {
    flexDirection: 'row',
    padding: spacing.lg,
    gap: spacing.md,
    backgroundColor: colors.mutedBg,
  },
  iconWrap: { width: 64, height: 64, justifyContent: 'center', alignItems: 'center' },
  icon: { fontSize: 48 },
  title: { fontSize: 22, fontWeight: '700', color: colors.fg },
  plate: { fontSize: 16, color: colors.fg, marginTop: 2 },
  subtle: { fontSize: 13, color: colors.muted, marginTop: 2 },
  tabsRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: colors.border },
  tabButton: { flex: 1, paddingVertical: spacing.md, alignItems: 'center' },
  tabButtonActive: { borderBottomWidth: 2, borderBottomColor: colors.primary },
  tabText: { fontSize: 14, fontWeight: '500', color: colors.muted },
  tabTextActive: { color: colors.primary, fontWeight: '600' },
  techList: { padding: spacing.md, gap: spacing.sm },
  exportSection: { marginTop: spacing.md },
  techRow: {
    flexDirection: 'row',
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  techLabel: { flex: 1, fontSize: 14, color: colors.muted },
  techValue: { flex: 1.5, fontSize: 14, color: colors.fg, textAlign: 'right' },
});
