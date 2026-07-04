import { ScrollView, StyleSheet, Text, View, Pressable } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useMeShopInterventionDetail } from '@/queries/meShopInterventionDetail';
import { LoadingState } from '@/components/LoadingState';
import { ErrorState } from '@/components/ErrorState';
import { BadgeContestato } from '@/components/BadgeContestato';
import { ApiError } from '@/lib/api-error';
import { mapErrorToUserMessage } from '@/lib/error-messages';
import { formatDate, formatDueUrgency, formatKm } from '@/lib/format';
import {
  DISPUTE_STATUS_LABELS,
  REASON_CATEGORY_LABELS,
  isDisputeActive,
} from '@/lib/dispute-labels';
import { colors, spacing } from '@/theme/colors';
import { PushReminderBanner } from '@/components/PushReminderBanner';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function InterventionDetailScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = typeof params.id === 'string' && UUID_RE.test(params.id) ? params.id : '';
  const router = useRouter();
  const detail = useMeShopInterventionDetail(id);

  if (!id) return <ErrorState message="Intervento non valido." />;
  if (detail.isLoading || !detail.data) {
    if (detail.isError) {
      const code = detail.error instanceof ApiError ? detail.error.code : undefined;
      return <ErrorState message={mapErrorToUserMessage(code)} onRetry={detail.refetch} />;
    }
    return <LoadingState variant="fullscreen" />;
  }

  const { intervention, disputes } = detail.data;
  const hasActiveDispute = disputes.some((d) => isDisputeActive(d.status));
  // Default the arrays: a persisted react-query cache from a pre-upgrade app
  // version may rehydrate an intervention without these newer fields, and
  // stale-while-revalidate renders it before the refetch lands.
  const partsReplaced = intervention.partsReplaced ?? [];
  const generatedDeadlines = intervention.generatedDeadlines ?? [];
  const checklistItems = intervention.checklistItems ?? [];

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: 'Intervento' }} />
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <PushReminderBanner />
        <View style={styles.card}>
          <View style={styles.badgeRow}>
            {intervention.isDisputed ? <BadgeContestato /> : null}
            <Text style={styles.tenant}>
              {intervention.tenant.businessName}
              {intervention.tenant.locationCity ? ` · ${intervention.tenant.locationCity}` : ''}
            </Text>
          </View>
          <Text style={styles.title}>{intervention.type.name_it}</Text>
          <Text style={styles.meta}>
            {formatDate(intervention.interventionDate)} · {formatKm(intervention.odometerKm)}
          </Text>
          {intervention.description ? (
            <Text style={styles.description}>{intervention.description}</Text>
          ) : null}
        </View>

        {checklistItems.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Voci eseguite</Text>
            {checklistItems.map((item, idx) => (
              <Text key={item.id ?? idx} style={styles.checklistItem}>
                {item.label}
              </Text>
            ))}
          </View>
        ) : null}

        {partsReplaced.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Ricambi sostituiti ({partsReplaced.length})</Text>
            {partsReplaced.map((p, idx) => (
              <View key={idx} style={styles.part}>
                <Text style={styles.partName}>
                  {p.name}
                  {p.code ? ` · ${p.code}` : ''} · ×{p.quantity}
                </Text>
                {p.notes ? <Text style={styles.partNotes}>{p.notes}</Text> : null}
              </View>
            ))}
          </View>
        ) : null}

        {generatedDeadlines.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Prossime scadenze</Text>
            {generatedDeadlines.map((d) => {
              const urgency = formatDueUrgency(d.dueDate, d.status);
              const km =
                d.dueOdometerKm != null ? `Alla soglia di ${formatKm(d.dueOdometerKm)}` : '';
              const date = d.dueDate ? `Entro il ${formatDate(d.dueDate)}` : '';
              const when = [date, km].filter(Boolean).join(' · ');
              return (
                <View key={d.id} style={styles.deadline}>
                  <View style={styles.deadlineHead}>
                    <Text style={styles.deadlineTitle}>{d.type.name_it}</Text>
                    <Text style={styles.deadlineBadge}>{urgency.label}</Text>
                  </View>
                  {d.description ? <Text style={styles.deadlineDesc}>{d.description}</Text> : null}
                  {when ? <Text style={styles.deadlineMeta}>{when}</Text> : null}
                </View>
              );
            })}
          </View>
        ) : null}

        {disputes.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Contestazioni</Text>
            {disputes.map((d) => (
              <View key={d.id} style={styles.dispute}>
                <Text style={styles.disputeStatus}>{DISPUTE_STATUS_LABELS[d.status]}</Text>
                <Text style={styles.disputeReason}>{REASON_CATEGORY_LABELS[d.reasonCategory]}</Text>
                <Text style={styles.disputeBody}>{d.customerDescription}</Text>
                {d.tenantResponse ? (
                  <View style={styles.response}>
                    <Text style={styles.responseLabel}>Risposta dell&apos;officina</Text>
                    <Text style={styles.disputeBody}>{d.tenantResponse}</Text>
                  </View>
                ) : null}
              </View>
            ))}
          </View>
        ) : null}

        {!hasActiveDispute ? (
          <Pressable
            accessibilityRole="button"
            style={styles.disputeBtn}
            onPress={() => router.push(`/interventions/${id}/dispute`)}
          >
            <Text style={styles.disputeBtnText}>Contesta intervento</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, gap: spacing.lg },
  card: { gap: spacing.xs },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  tenant: { fontSize: 13, color: colors.muted, fontWeight: '600' },
  title: { fontSize: 18, fontWeight: '700', color: colors.fg },
  meta: { fontSize: 13, color: colors.muted },
  description: { fontSize: 15, color: colors.fg, marginTop: spacing.xs },
  section: { gap: spacing.sm },
  sectionTitle: { fontSize: 15, fontWeight: '700', color: colors.fg },
  checklistItem: { fontSize: 14, color: colors.fg },
  part: {
    gap: 2,
    paddingVertical: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  partName: { fontSize: 14, color: colors.fg },
  partNotes: { fontSize: 13, color: colors.muted },
  deadline: {
    gap: spacing.xs,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
  },
  deadlineHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  deadlineTitle: { fontSize: 14, fontWeight: '600', color: colors.fg, flexShrink: 1 },
  deadlineBadge: { fontSize: 12, fontWeight: '600', color: colors.muted },
  deadlineDesc: { fontSize: 13, color: colors.fg },
  deadlineMeta: { fontSize: 12, color: colors.muted },
  dispute: {
    gap: spacing.xs,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
  },
  disputeStatus: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.danger,
    textTransform: 'uppercase',
  },
  disputeReason: { fontSize: 14, fontWeight: '600', color: colors.fg },
  disputeBody: { fontSize: 14, color: colors.fg },
  response: {
    marginTop: spacing.sm,
    gap: spacing.xs,
    paddingLeft: spacing.md,
    borderLeftWidth: 2,
    borderLeftColor: colors.primary,
  },
  responseLabel: { fontSize: 12, fontWeight: '600', color: colors.muted },
  disputeBtn: {
    backgroundColor: colors.primary,
    paddingVertical: spacing.md,
    borderRadius: 8,
    alignItems: 'center',
  },
  disputeBtnText: { color: colors.primaryFg, fontSize: 16, fontWeight: '600' },
});
