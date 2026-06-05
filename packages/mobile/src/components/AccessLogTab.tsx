import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text } from 'react-native';
import { AccessLogRow } from '@/components/AccessLogRow';
import { LoadingState } from '@/components/LoadingState';
import { ErrorState } from '@/components/ErrorState';
import { EmptyState } from '@/components/EmptyState';
import { mapErrorToUserMessage } from '@/lib/error-messages';
import { colors, spacing } from '@/theme/colors';
import type { CustomerAccessEntry } from '@/lib/types/accessLog';

type Props = {
  entries: CustomerAccessEntry[];
  isLoading: boolean;
  isError: boolean;
  errorCode?: string;
  onRetry: () => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
};

export function AccessLogTab({
  entries,
  isLoading,
  isError,
  errorCode,
  onRetry,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: Props) {
  if (isLoading) return <LoadingState variant="list" />;
  if (isError) return <ErrorState message={mapErrorToUserMessage(errorCode)} onRetry={onRetry} />;
  if (entries.length === 0) {
    return (
      <EmptyState
        title="Nessun accesso registrato"
        body="Non risultano ancora accessi al libretto di questo veicolo."
      />
    );
  }
  return (
    <FlatList
      data={entries}
      keyExtractor={(e, i) => `${e.occurredAt}-${i}`}
      renderItem={({ item }) => <AccessLogRow entry={item} />}
      scrollEnabled={false}
      ListFooterComponent={
        hasNextPage ? (
          <Pressable
            style={styles.loadMore}
            accessibilityRole="button"
            disabled={isFetchingNextPage}
            onPress={onLoadMore}
          >
            {isFetchingNextPage ? (
              <ActivityIndicator color={colors.primary} />
            ) : (
              <Text style={styles.loadMoreText}>Carica altri</Text>
            )}
          </Pressable>
        ) : null
      }
    />
  );
}

const styles = StyleSheet.create({
  loadMore: {
    margin: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.primary,
    alignItems: 'center',
  },
  loadMoreText: { color: colors.primary, fontSize: 14, fontWeight: '600' },
});
