// Personal-deadline detail screen (F-CLI-306 PR3, Task 8). Shows a read-only
// summary and, while the deadline is actionable (open/overdue), exposes the
// complete / edit / delete actions. Completing a recurring deadline triggers
// the BR-296 guided renewal by routing to a pre-filled create form.
// User-facing strings are Italian; comments are English.

import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { format, parse } from 'date-fns';

import {
  usePersonalDeadline,
  useCompletePersonalDeadline,
  useDeletePersonalDeadline,
} from '@/queries/personalDeadlines';
import { CATEGORY_META, categoryLabel } from '@/lib/personalDeadlineMeta';
import { LoadingState } from '@/components/LoadingState';
import { ErrorState } from '@/components/ErrorState';
import { ApiError } from '@/lib/api-error';
import { mapErrorToUserMessage } from '@/lib/error-messages';
import type { PersonalDeadlineStatus } from '@/lib/types/personalDeadline';
import { colors, spacing } from '@/theme/colors';

const STATUS_LABELS: Record<PersonalDeadlineStatus, string> = {
  open: 'Aperta',
  overdue: 'Scaduta',
  completed: 'Completata',
  cancelled: 'Annullata',
};

function formatDueDate(dueDate: string): string {
  return format(parse(dueDate, 'yyyy-MM-dd', new Date()), 'dd/MM/yyyy');
}

export default function MyDeadlineDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  const { data, isLoading, isError, error } = usePersonalDeadline(id);
  const complete = useCompletePersonalDeadline();
  const del = useDeletePersonalDeadline();

  const [serverError, setServerError] = useState<string | undefined>(undefined);

  if (isError) {
    return (
      <>
        <Stack.Screen options={{ headerShown: true, title: 'Scadenza' }} />
        <ErrorState
          message={mapErrorToUserMessage(error instanceof ApiError ? error.code : undefined)}
        />
      </>
    );
  }

  if (isLoading || !data) {
    return (
      <>
        <Stack.Screen options={{ headerShown: true, title: 'Scadenza' }} />
        <LoadingState />
      </>
    );
  }

  const submitting = complete.isPending || del.isPending;
  const actionable = data.status === 'open' || data.status === 'overdue';
  const meta = CATEGORY_META[data.category];

  async function onComplete() {
    setServerError(undefined);
    try {
      const res = await complete.mutateAsync(id);
      // BR-296 — completing a recurring deadline produces a renewal suggestion;
      // route to the create form pre-filled with it.
      if (res.renewalSuggestion) {
        router.replace({
          pathname: '/my-deadlines/new',
          params: { prefill: encodeURIComponent(JSON.stringify(res.renewalSuggestion)) },
        });
      } else {
        router.back();
      }
    } catch (err) {
      setServerError(mapErrorToUserMessage(err instanceof ApiError ? err.code : undefined));
    }
  }

  function onEdit() {
    router.push({ pathname: '/my-deadlines/new', params: { id } });
  }

  function onDelete() {
    Alert.alert('Elimina scadenza', 'Vuoi eliminare questa scadenza?', [
      { text: 'Annulla', style: 'cancel' },
      {
        text: 'Elimina',
        style: 'destructive',
        onPress: () => {
          void doDelete();
        },
      },
    ]);
  }

  async function doDelete() {
    setServerError(undefined);
    try {
      await del.mutateAsync(id);
      router.back();
    } catch (err) {
      setServerError(mapErrorToUserMessage(err instanceof ApiError ? err.code : undefined));
    }
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: 'Scadenza' }} />
      <ScrollView style={styles.container} contentContainerStyle={styles.body}>
        <View style={styles.titleRow}>
          <Ionicons name={meta.icon} size={24} color={colors.primary} />
          <Text style={styles.title}>{categoryLabel(data)}</Text>
        </View>

        <View style={styles.badge}>
          <Text style={styles.badgeText}>{STATUS_LABELS[data.status]}</Text>
        </View>

        <Field label="Veicolo">
          {data.vehicle.plate} · {data.vehicle.make} {data.vehicle.model}
        </Field>
        <Field label="Scadenza">{formatDueDate(data.dueDate)}</Field>

        {data.reminderLeadDays.length > 0 ? (
          <Field label="Promemoria">
            {`Promemoria: ${data.reminderLeadDays.join(', ')} giorni prima`}
            {data.reminderDailyTailDays && data.reminderDailyTailDays > 0
              ? `, poi ogni giorno negli ultimi ${data.reminderDailyTailDays} giorni`
              : ''}
          </Field>
        ) : null}

        <Field label="Canali">
          {[data.notifyPush ? 'Push' : null, data.notifyEmail ? 'Email' : null]
            .filter(Boolean)
            .join(' · ') || 'Nessuno'}
        </Field>

        {data.recurrenceMonths ? (
          <Field label="Ricorrenza">{`Si ripete ogni ${data.recurrenceMonths} mesi`}</Field>
        ) : null}

        {data.notes ? <Field label="Note">{data.notes}</Field> : null}

        {serverError ? (
          <View style={styles.errorBanner} accessibilityRole="alert">
            <Text style={styles.errorText}>{serverError}</Text>
          </View>
        ) : null}

        {actionable ? (
          <View style={styles.actions}>
            <Pressable
              testID="complete-button"
              onPress={() => void onComplete()}
              accessibilityRole="button"
              disabled={submitting}
              style={({ pressed }) => [
                styles.primaryBtn,
                pressed && styles.pressed,
                submitting && styles.disabled,
              ]}
            >
              <Text style={styles.primaryBtnText}>Segna come fatta</Text>
            </Pressable>
            <Pressable
              testID="edit-button"
              onPress={onEdit}
              accessibilityRole="button"
              disabled={submitting}
              style={({ pressed }) => [
                styles.secondaryBtn,
                pressed && styles.pressed,
                submitting && styles.disabled,
              ]}
            >
              <Text style={styles.secondaryBtnText}>Modifica</Text>
            </Pressable>
            <Pressable
              testID="delete-button"
              onPress={onDelete}
              accessibilityRole="button"
              disabled={submitting}
              style={({ pressed }) => [
                styles.dangerBtn,
                pressed && styles.pressed,
                submitting && styles.disabled,
              ]}
            >
              <Text style={styles.dangerBtnText}>Elimina</Text>
            </Pressable>
          </View>
        ) : null}
      </ScrollView>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={styles.fieldValue}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  body: { padding: spacing.lg, gap: spacing.md },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  title: { fontSize: 20, fontWeight: '700', color: colors.fg },
  badge: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    backgroundColor: colors.mutedBg,
  },
  badgeText: { fontSize: 13, fontWeight: '600', color: colors.fg },
  field: { gap: spacing.xs },
  fieldLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.muted,
    textTransform: 'uppercase',
  },
  fieldValue: { fontSize: 15, color: colors.fg },
  errorBanner: {
    backgroundColor: colors.dangerBg,
    padding: spacing.md,
    borderRadius: 8,
    borderLeftWidth: 4,
    borderLeftColor: colors.danger,
  },
  errorText: { color: colors.danger, fontSize: 13 },
  actions: { gap: spacing.md, marginTop: spacing.sm },
  primaryBtn: {
    backgroundColor: colors.primary,
    paddingVertical: spacing.md,
    borderRadius: 8,
    alignItems: 'center',
  },
  primaryBtnText: { color: colors.primaryFg, fontSize: 16, fontWeight: '600' },
  secondaryBtn: {
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.md,
    borderRadius: 8,
    alignItems: 'center',
  },
  secondaryBtnText: { color: colors.fg, fontSize: 16, fontWeight: '600' },
  dangerBtn: {
    borderWidth: 1,
    borderColor: colors.danger,
    paddingVertical: spacing.md,
    borderRadius: 8,
    alignItems: 'center',
  },
  dangerBtnText: { color: colors.danger, fontSize: 16, fontWeight: '600' },
  pressed: { opacity: 0.8 },
  disabled: { opacity: 0.5 },
});
