import { FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState, useCallback, useEffect, useRef } from 'react';
import { useMeDeadlines } from '@/queries/meDeadlines';
import type { MeDeadline } from '@/lib/types/deadline';
import { DeadlineRow } from '@/components/DeadlineRow';
import { LoadingState } from '@/components/LoadingState';
import { ErrorState } from '@/components/ErrorState';
import { EmptyState } from '@/components/EmptyState';
import { SegmentedControl } from '@/components/SegmentedControl';
import { PersonalDeadlineList } from '@/components/PersonalDeadlineList';
import { mapErrorToUserMessage } from '@/lib/error-messages';
import { ApiError } from '@/lib/api-error';
import { colors } from '@/theme/colors';

type Segment = 'officina' | 'personali';

const SEGMENT_OPTIONS: { key: Segment; label: string }[] = [
  { key: 'officina', label: 'Officina' },
  { key: 'personali', label: 'Personali' },
];

export default function DeadlinesScreen() {
  // The notification tap deep-link may target the personal segment; default to
  // officina otherwise (preserves the historical single-list behavior).
  const { highlight, segment: segmentParam } = useLocalSearchParams<{
    highlight?: string;
    segment?: string;
  }>();
  const [segment, setSegment] = useState<Segment>(
    segmentParam === 'personal' ? 'personali' : 'officina',
  );

  return (
    <View style={styles.container}>
      <SegmentedControl options={SEGMENT_OPTIONS} value={segment} onChange={setSegment} />
      {segment === 'officina' ? (
        <OfficinaDeadlineList highlight={highlight} />
      ) : (
        <PersonalDeadlineList />
      )}
    </View>
  );
}

// Workshop (officina) deadlines — read-only, tap routes to the vehicle detail.
// Behavior preserved 1:1 from the pre-segment screen, including the
// notification-tap highlight/scroll logic.
function OfficinaDeadlineList({ highlight }: { highlight?: string }) {
  const router = useRouter();
  const listRef = useRef<FlatList<MeDeadline>>(null);
  // Scroll once per highlight value: `data` changes identity on every refetch
  // (pull-to-refresh, invalidation) and must not re-yank the list afterwards.
  const scrolledForRef = useRef<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const { data, isLoading, isError, error, refetch } = useMeDeadlines();

  useEffect(() => {
    if (!highlight || !data || scrolledForRef.current === highlight) return;
    const index = data.findIndex((d) => d.id === highlight);
    if (index < 0) return; // deadline gone (e.g. completed meanwhile) — plain list
    scrolledForRef.current = highlight;
    // Defer so the FlatList has mounted its rows before scrolling.
    const timer = setTimeout(() => {
      listRef.current?.scrollToIndex({ index, viewPosition: 0.3, animated: true });
    }, 250);
    return () => clearTimeout(timer);
  }, [highlight, data]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refetch();
    } finally {
      setRefreshing(false);
    }
  }, [refetch]);

  if (isLoading) return <LoadingState variant="list" />;

  if (isError) {
    const code = error instanceof ApiError ? error.code : undefined;
    return <ErrorState message={mapErrorToUserMessage(code)} onRetry={refetch} />;
  }

  if (!data || data.length === 0) {
    return <EmptyState title="Nessuna scadenza" body="Non hai scadenze aperte sui tuoi veicoli." />;
  }

  return (
    <FlatList
      ref={listRef}
      data={data}
      keyExtractor={(d) => d.id}
      renderItem={({ item }) => (
        <DeadlineRow
          deadline={item}
          highlighted={item.id === highlight}
          onPress={() => router.push(`/(tabs)/vehicles/${item.vehicleId}`)}
        />
      )}
      onScrollToIndexFailed={(info) => {
        // Variable-height rows: fall back to an estimated offset, then retry.
        listRef.current?.scrollToOffset({
          offset: info.averageItemLength * info.index,
          animated: true,
        });
        setTimeout(() => {
          listRef.current?.scrollToIndex({
            index: info.index,
            viewPosition: 0.3,
            animated: true,
          });
        }, 300);
      }}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
      }
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
});
