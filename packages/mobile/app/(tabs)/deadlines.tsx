import { FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useState, useCallback } from 'react';
import { useMeDeadlines } from '@/queries/meDeadlines';
import { DeadlineRow } from '@/components/DeadlineRow';
import { LoadingState } from '@/components/LoadingState';
import { ErrorState } from '@/components/ErrorState';
import { EmptyState } from '@/components/EmptyState';
import { mapErrorToUserMessage } from '@/lib/error-messages';
import { ApiError } from '@/lib/api-error';
import { colors } from '@/theme/colors';

export default function DeadlinesScreen() {
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);
  const { data, isLoading, isError, error, refetch } = useMeDeadlines();

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
    <View style={styles.container}>
      <FlatList
        data={data}
        keyExtractor={(d) => d.id}
        renderItem={({ item }) => (
          <DeadlineRow
            deadline={item}
            onPress={() => router.push(`/(tabs)/vehicles/${item.vehicleId}`)}
          />
        )}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
          />
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
});
