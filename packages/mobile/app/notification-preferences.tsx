import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import {
  useNotificationPreferences,
  useUpdateNotificationPreference,
} from '@/queries/notificationPreferences';
import { EDITABLE_EMAIL_KEYS, type EditableEmailKey } from '@/lib/types/notification-preferences';
import { LoadingState } from '@/components/LoadingState';
import { ErrorState } from '@/components/ErrorState';
import { ApiError } from '@/lib/api-error';
import { mapErrorToUserMessage } from '@/lib/error-messages';
import { colors, spacing } from '@/theme/colors';

// Italian labels for the editable email channels. Order follows
// EDITABLE_EMAIL_KEYS so the screen output is deterministic.
const LABELS: Record<EditableEmailKey, string> = {
  intervention_updates: 'Aggiornamenti interventi',
  deadline_reminder: 'Promemoria scadenze',
  ownership_transfer: 'Trasferimenti di proprietà',
  marketing: 'Novità e promozioni',
};

export default function NotificationPreferencesScreen() {
  const prefs = useNotificationPreferences();
  const update = useUpdateNotificationPreference();

  if (prefs.isLoading) return <LoadingState variant="fullscreen" />;
  if (prefs.isError) {
    const code = prefs.error instanceof ApiError ? prefs.error.code : undefined;
    return <ErrorState message={mapErrorToUserMessage(code)} onRetry={prefs.refetch} />;
  }

  const email = prefs.data!.email;

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: 'Notifiche' }} />
      <ScrollView style={styles.container} contentContainerStyle={styles.body}>
        {EDITABLE_EMAIL_KEYS.map((key) => (
          <View key={key} style={styles.row}>
            <Text style={styles.label}>{LABELS[key]}</Text>
            <Switch
              testID={`toggle-${key}`}
              accessibilityLabel={LABELS[key]}
              value={email[key]}
              onValueChange={(value) => update.mutate({ key, value })}
            />
          </View>
        ))}
        {/* BR-260: transfer-invitation and other service emails are always sent. */}
        <Text style={styles.hint}>
          Alcune comunicazioni di servizio (es. inviti al trasferimento di un veicolo) vengono
          sempre inviate.
        </Text>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  body: { padding: spacing.lg, gap: spacing.md },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.mutedBg,
    padding: spacing.md,
    borderRadius: 8,
  },
  label: { fontSize: 16, color: colors.fg, flex: 1, paddingRight: spacing.md },
  hint: { fontSize: 13, color: colors.muted, marginTop: spacing.sm },
});
