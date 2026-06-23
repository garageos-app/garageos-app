// Soft, non-blocking banner that nudges the user to enable push notifications.
// Shown only when the OS permission is 'denied' or 'blocked'; hidden once
// granted or dismissed for the current session.
import { useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { usePushPermissionStatus } from '@/queries/pushPermission';
import { useEnablePush } from '@/lib/useEnablePush';
import { colors, spacing } from '@/theme/colors';

export function PushReminderBanner() {
  const { data: status } = usePushPermissionStatus();
  const { enable } = useEnablePush();
  const [dismissed, setDismissed] = useState(false);

  // Unknown/loading: do not flash anything.
  if (status === undefined) return null;
  // User already has permissions: nothing to nudge.
  if (status === 'granted') return null;
  // User dismissed for this session.
  if (dismissed) return null;

  const body =
    status === 'blocked'
      ? 'Le notifiche sono disattivate. Apri le impostazioni per abilitarle.'
      : 'Attiva le notifiche per ricevere aggiornamenti sui tuoi interventi e promemoria per le scadenze.';

  const handlePress = () => {
    if (status === 'blocked') {
      void Linking.openSettings();
    } else {
      void enable();
    }
  };

  return (
    <View testID="push-reminder-banner" style={styles.container}>
      <Pressable style={styles.body} onPress={handlePress} accessibilityRole="button">
        <Text style={styles.text}>{body}</Text>
      </Pressable>
      <Pressable
        testID="push-banner-dismiss"
        accessibilityLabel="Chiudi"
        accessibilityRole="button"
        onPress={() => setDismissed(true)}
        style={styles.dismiss}
      >
        <Text style={styles.dismissText}>×</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.warningBg,
    borderRadius: 8,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  body: {
    flex: 1,
  },
  text: {
    fontSize: 14,
    color: colors.warningFg,
  },
  dismiss: {
    paddingLeft: spacing.sm,
  },
  dismissText: {
    fontSize: 18,
    color: colors.warningFg,
    lineHeight: 18,
  },
});
