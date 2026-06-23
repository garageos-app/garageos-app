// One-time "soft-ask" priming modal shown after first login to prompt the user
// to enable push notifications. Shown only once (AsyncStorage flag) and only
// when the OS permission is 'denied' — not 'blocked', because the OS prompt
// would not appear when permission is blocked.
import React, { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { usePushPermissionStatus } from '@/queries/pushPermission';
import { useEnablePush } from '@/lib/useEnablePush';
import { readSoftAskSeen, markSoftAskSeen } from '@/lib/push-prompt-storage';
import { colors, spacing } from '@/theme/colors';

export function PushSoftAskModal(): React.JSX.Element | null {
  // undefined = still loading from AsyncStorage; boolean = resolved.
  const [seen, setSeen] = useState<boolean | undefined>(undefined);
  const { data: status } = usePushPermissionStatus();
  const { enable } = useEnablePush();

  // Load the one-time flag on mount. Guard with a cancelled flag (see
  // AuthContext pattern) to avoid setting state on an unmounted component.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const value = await readSoftAskSeen();
      if (cancelled) return;
      setSeen(value);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Render nothing until both the seen flag and OS permission status are resolved.
  if (seen === undefined || status === undefined) return null;

  // Show only when permission is 'denied' and the modal has not been seen.
  // 'blocked' is excluded: the OS prompt would not appear in that state.
  const visible = status === 'denied' && seen === false;

  if (!visible) return null;

  const handleEnable = async () => {
    await enable();
    // Mark seen regardless of what enable() returned — we do not auto-reprompt.
    await markSoftAskSeen();
    setSeen(true);
  };

  const handleDismiss = async () => {
    // Do NOT call enable() — do not burn the one OS prompt on an undecided user.
    await markSoftAskSeen();
    setSeen(true);
  };

  return (
    <Modal
      transparent
      animationType="fade"
      visible={visible}
      onRequestClose={() => void handleDismiss()}
    >
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>Attiva le notifiche</Text>
          <Text style={styles.body}>
            Ti avvisiamo quando ci sono aggiornamenti sui tuoi interventi e promemoria per le
            scadenze dei tuoi veicoli.
          </Text>
          <Pressable
            testID="softask-enable"
            accessibilityRole="button"
            style={styles.primaryButton}
            onPress={() => void handleEnable()}
          >
            <Text style={styles.primaryButtonText}>Attiva notifiche</Text>
          </Pressable>
          <Pressable
            testID="softask-dismiss"
            accessibilityRole="button"
            style={styles.secondaryButton}
            onPress={() => void handleDismiss()}
          >
            <Text style={styles.secondaryButtonText}>Non ora</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.lg,
  },
  card: {
    backgroundColor: colors.bg,
    borderRadius: 12,
    padding: spacing.lg,
    width: '100%',
    maxWidth: 400,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.fg,
    marginBottom: spacing.sm,
  },
  body: {
    fontSize: 15,
    color: colors.muted,
    lineHeight: 22,
    marginBottom: spacing.lg,
  },
  primaryButton: {
    backgroundColor: colors.primary,
    borderRadius: 8,
    paddingVertical: spacing.sm + spacing.xs,
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  primaryButtonText: {
    color: colors.primaryFg,
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryButton: {
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  secondaryButtonText: {
    color: colors.muted,
    fontSize: 15,
  },
});
