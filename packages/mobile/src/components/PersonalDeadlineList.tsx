// Grouped, editable list of the customer's personal vehicle deadlines
// (F-CLI-306). Rows are bucketed by urgency; a FAB opens the create form.
// User-facing strings are in Italian.

import { useCallback, useState } from 'react';
import { Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { usePersonalDeadlines } from '@/queries/personalDeadlines';
import { BUCKET_ORDER, BUCKET_TITLE, urgencyBucket } from '@/lib/personalDeadlineMeta';
import type { PersonalDeadlineDto } from '@/lib/types/personalDeadline';
import { PersonalDeadlineRow } from '@/components/PersonalDeadlineRow';
import { LoadingState } from '@/components/LoadingState';
import { ErrorState } from '@/components/ErrorState';
import { EmptyState } from '@/components/EmptyState';
import { mapErrorToUserMessage } from '@/lib/error-messages';
import { ApiError } from '@/lib/api-error';
import { colors, spacing } from '@/theme/colors';

type Section = { title: string; data: PersonalDeadlineDto[] };

// Group deadlines into urgency sections in BUCKET_ORDER, dropping empty buckets.
function buildSections(deadlines: PersonalDeadlineDto[]): Section[] {
  return BUCKET_ORDER.map((bucket) => ({
    title: BUCKET_TITLE[bucket],
    data: deadlines.filter((d) => urgencyBucket(d.dueDate, d.status) === bucket),
  })).filter((section) => section.data.length > 0);
}

export function PersonalDeadlineList() {
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);
  const { data, isLoading, isError, error, refetch } = usePersonalDeadlines();

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
      <View style={styles.container}>
        <EmptyState
          title="Nessuna scadenza personale"
          body="Aggiungi una scadenza per i tuoi veicoli."
        />
        <Fab onPress={() => router.push('/my-deadlines/new')} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <SectionList
        sections={buildSections(data)}
        keyExtractor={(d) => d.id}
        renderSectionHeader={({ section }) => (
          <Text style={styles.sectionHeader}>{section.title}</Text>
        )}
        renderItem={({ item }) => (
          <PersonalDeadlineRow
            deadline={item}
            onPress={() => router.push(`/my-deadlines/${item.id}`)}
          />
        )}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
          />
        }
      />
      <Fab onPress={() => router.push('/my-deadlines/new')} />
    </View>
  );
}

function Fab({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Aggiungi scadenza"
    >
      <Ionicons name="add" size={28} color={colors.primaryFg} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  listContent: { paddingBottom: 96 },
  sectionHeader: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.muted,
    textTransform: 'uppercase',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    backgroundColor: colors.bg,
  },
  fab: {
    position: 'absolute',
    right: spacing.lg,
    bottom: spacing.lg,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  fabPressed: { opacity: 0.85 },
});
