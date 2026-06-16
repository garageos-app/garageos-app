import { useEffect, useRef, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import {
  useNotificationPreferences,
  useUpdateNotificationPreference,
} from '@/queries/notificationPreferences';
import { useRegisterPushToken, useDeletePushToken } from '@/queries/pushTokens';
import {
  ensurePushPermission,
  getPushPermissionStatus,
  getDevicePushToken,
  buildRegistrationPayload,
} from '@/lib/push';
import { readPushTokenId } from '@/lib/push-token-storage';
import {
  EDITABLE_EMAIL_KEYS,
  EDITABLE_PUSH_KEYS,
  type EditableEmailKey,
  type EditablePushKey,
} from '@/lib/types/notification-preferences';
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
  personal_deadline_reminder: 'Scadenze personali',
};

// Italian labels for the editable push events. Order follows EDITABLE_PUSH_KEYS.
const PUSH_LABELS: Record<EditablePushKey, string> = {
  intervention_updates: 'Aggiornamenti interventi',
  deadline_reminder: 'Promemoria scadenze',
  ownership_transfer: 'Trasferimenti di proprietà',
  personal_deadline_reminder: 'Scadenze personali',
};

export default function NotificationPreferencesScreen() {
  const prefs = useNotificationPreferences();
  const update = useUpdateNotificationPreference();

  // Device-level push opt-in (F-CLI-302). Declared before the early returns
  // below so hook order stays stable across loading/error renders.
  const register = useRegisterPushToken();
  const del = useDeletePushToken();
  const [pushOn, setPushOn] = useState(false);
  const [blocked, setBlocked] = useState(false);
  // Once the user toggles, the async mount refresh must not clobber the
  // resulting state (its later-resolving setState would otherwise win).
  const interacted = useRef(false);

  // Initial state: ON only when OS permission is granted AND we hold a stored
  // token id. When granted, silently refresh the token (idempotent upsert;
  // absorbs rotation). Best-effort — a failed refresh never surfaces an error.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const status = await getPushPermissionStatus();
      const id = await readPushTokenId();
      if (cancelled || interacted.current) return;
      setBlocked(status === 'blocked');
      setPushOn(status === 'granted' && !!id);
      if (status === 'granted') {
        try {
          const token = await getDevicePushToken();
          await register.mutateAsync(buildRegistrationPayload(token));
          if (!cancelled && !interacted.current) setPushOn(true);
        } catch {
          // ignore — best-effort refresh
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onTogglePush = async (next: boolean) => {
    interacted.current = true;
    if (next) {
      const perm = await ensurePushPermission();
      if (perm === 'blocked') {
        setBlocked(true);
        setPushOn(false);
        return;
      }
      if (perm !== 'granted') {
        setPushOn(false);
        return;
      }
      setBlocked(false);
      try {
        const token = await getDevicePushToken();
        await register.mutateAsync(buildRegistrationPayload(token));
        setPushOn(true);
      } catch {
        setPushOn(false);
      }
    } else {
      const id = await readPushTokenId();
      if (id) {
        try {
          await del.mutateAsync(id);
        } catch {
          // best-effort
        }
      }
      setPushOn(false);
    }
  };

  if (prefs.isError) {
    const code = prefs.error instanceof ApiError ? prefs.error.code : undefined;
    return <ErrorState message={mapErrorToUserMessage(code)} onRetry={prefs.refetch} />;
  }
  // `!prefs.data` also covers the offline-paused case (status 'pending',
  // fetchStatus 'paused'), where isLoading is false but no data exists yet.
  if (prefs.isLoading || !prefs.data) return <LoadingState variant="fullscreen" />;

  const email = prefs.data.email;
  const push = prefs.data.push;

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: 'Notifiche' }} />
      <ScrollView style={styles.container} contentContainerStyle={styles.body}>
        <Text style={styles.sectionTitle}>Dispositivo</Text>
        <View style={styles.row}>
          <Text style={styles.label}>Notifiche su questo dispositivo</Text>
          <Switch
            testID="toggle-device-push"
            accessibilityLabel="Notifiche su questo dispositivo"
            value={pushOn}
            onValueChange={(v) => void onTogglePush(v)}
          />
        </View>
        {blocked && (
          <Pressable onPress={() => void Linking.openSettings()}>
            <Text style={styles.hint}>
              Le notifiche sono disattivate. Abilitale nelle impostazioni del dispositivo.
            </Text>
          </Pressable>
        )}

        <Text style={styles.sectionTitle}>Push</Text>
        <Text style={styles.hint}>
          Le notifiche push richiedono anche le notifiche abilitate su questo dispositivo (sopra).
        </Text>
        {EDITABLE_PUSH_KEYS.map((key) => (
          <View key={key} style={styles.row}>
            <Text style={styles.label}>{PUSH_LABELS[key]}</Text>
            <Switch
              testID={`toggle-push-${key}`}
              accessibilityLabel={`Push: ${PUSH_LABELS[key]}`}
              value={push[key]}
              onValueChange={(value) => update.mutate({ channel: 'push', key, value })}
            />
          </View>
        ))}

        <Text style={styles.sectionTitle}>Email</Text>
        {EDITABLE_EMAIL_KEYS.map((key) => (
          <View key={key} style={styles.row}>
            <Text style={styles.label}>{LABELS[key]}</Text>
            <Switch
              testID={`toggle-${key}`}
              accessibilityLabel={LABELS[key]}
              value={email[key]}
              onValueChange={(value) => update.mutate({ channel: 'email', key, value })}
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
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.muted,
    marginTop: spacing.sm,
  },
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
