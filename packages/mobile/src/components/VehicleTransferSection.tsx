// Entry point to the ownership-transfer flow from the vehicle detail TechTab
// (F-CLI-401). Derives "transfer in progress" from the seller's transfers list
// (no dedicated endpoint, spec §Punti d'ingresso): active transfer for this
// vehicle → banner to its detail; otherwise → button to /transfers/new.
import { Pressable, StyleSheet, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { useTransfers } from '@/queries/transfers';
import { isTransferActive, TRANSFER_STATUS_LABELS } from '@/lib/transfer-labels';
import { colors, spacing } from '@/theme/colors';

type Props = { vehicleId: string; vehicleLabel: string };

export function VehicleTransferSection({ vehicleId, vehicleLabel }: Props) {
  const router = useRouter();
  const transfers = useTransfers();

  // While loading render nothing (the section pops in); on error fall back to
  // the button — the server re-guards BR-047 with already_pending anyway.
  if (transfers.isLoading) return null;

  const active = (transfers.data ?? []).find(
    (t) => t.vehicleId === vehicleId && isTransferActive(t.status),
  );

  if (active) {
    return (
      <Pressable
        testID="transfer-in-progress-banner"
        onPress={() => router.push(`/transfers/${active.id}`)}
        accessibilityRole="button"
        style={({ pressed }) => [styles.banner, pressed && styles.pressed]}
      >
        <Text style={styles.bannerTitle}>Trasferimento in corso</Text>
        <Text style={styles.bannerBody}>
          {TRANSFER_STATUS_LABELS[active.status]} — tocca per i dettagli
        </Text>
      </Pressable>
    );
  }

  return (
    <Pressable
      testID="transfer-vehicle-button"
      onPress={() =>
        router.push({ pathname: '/transfers/new', params: { vehicleId, vehicleLabel } })
      }
      accessibilityRole="button"
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    >
      <Text style={styles.buttonText}>Trasferisci proprietà</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    borderWidth: 1,
    borderColor: colors.primary,
    paddingVertical: spacing.sm,
    borderRadius: 8,
    alignItems: 'center',
  },
  buttonText: { color: colors.primary, fontSize: 14, fontWeight: '600' },
  banner: {
    backgroundColor: colors.warningBg,
    padding: spacing.md,
    borderRadius: 8,
    gap: spacing.xs,
  },
  bannerTitle: { color: colors.warningFg, fontSize: 14, fontWeight: '700' },
  bannerBody: { color: colors.warningFg, fontSize: 12 },
  pressed: { opacity: 0.7 },
});
