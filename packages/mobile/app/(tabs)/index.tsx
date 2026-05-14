import { FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useState, useCallback } from 'react';
import { useMeVehiclesList } from '@/queries/meVehicles';
import { VehicleListItem } from '@/components/VehicleListItem';
import { LoadingState } from '@/components/LoadingState';
import { ErrorState } from '@/components/ErrorState';
import { EmptyState } from '@/components/EmptyState';
import { mapErrorToUserMessage } from '@/lib/error-messages';
import { ApiError } from '@/lib/api-error';
import { colors } from '@/theme/colors';

export default function VehicleListScreen() {
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);
  const { data, isLoading, isError, error, refetch } = useMeVehiclesList();

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
    return (
      <EmptyState
        title="Nessun veicolo"
        body="Non hai ancora veicoli associati al tuo account."
        cta={{ label: 'Aggiungi veicolo', onPress: () => {}, disabled: true }}
      />
    );
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={data}
        keyExtractor={(v) => v.id}
        renderItem={({ item }) => (
          <VehicleListItem
            vehicle={item}
            onPress={() => router.push(`/(tabs)/vehicles/${item.id}`)}
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
