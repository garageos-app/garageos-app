// VehicleHistoryExportButton — F-CLI-501 PR2. Outline button on the vehicle
// detail screen that exports the full shop history to a PDF (design §5.2).
// States: idle / pending ("Generazione PDF…" + spinner) / error (inline message).
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useVehicleHistoryPdfExport } from '@/queries/vehicleHistoryPdf';
import { ApiError } from '@/lib/api-error';
import { colors, spacing } from '@/theme/colors';

// Local, context-specific messages (design §5.3) — the export failure default is
// PDF-specific, not the generic app fallback.
function exportErrorMessage(code: string | undefined): string {
  if (code === 'me.vehicle.not_found') return 'Veicolo non trovato';
  return 'Impossibile generare il PDF. Riprova.';
}

export function VehicleHistoryExportButton({ vehicleId }: { vehicleId: string }) {
  const exportPdf = useVehicleHistoryPdfExport();
  const code = exportPdf.error instanceof ApiError ? exportPdf.error.code : undefined;

  return (
    <View style={styles.container}>
      <Pressable
        onPress={() => exportPdf.mutate(vehicleId)}
        accessibilityRole="button"
        disabled={exportPdf.isPending}
        style={({ pressed }) => [
          styles.button,
          pressed && styles.buttonPressed,
          exportPdf.isPending && styles.buttonDisabled,
        ]}
      >
        {exportPdf.isPending ? (
          <>
            <ActivityIndicator color={colors.primary} />
            <Text style={styles.buttonText}>Generazione PDF…</Text>
          </>
        ) : (
          <Text style={styles.buttonText}>Esporta PDF storico</Text>
        )}
      </Pressable>
      {exportPdf.isError ? (
        <Text style={styles.error} accessibilityRole="alert">
          {exportErrorMessage(code)}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.xs },
  button: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.bg,
  },
  buttonPressed: { opacity: 0.7 },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: colors.primary, fontSize: 15, fontWeight: '600' },
  error: { fontSize: 13, color: colors.danger, textAlign: 'center' },
});
