import { useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { extractGarageCode } from '@/lib/qr';
import { colors, spacing } from '@/theme/colors';

type Props = { onScanned: (code: string) => void; onCancel: () => void };

export function QrScanner({ onScanned, onCancel }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const [hint, setHint] = useState<string | null>(null);
  // onBarcodeScanned fires on every frame the QR is in view; guard so we hand a
  // valid code to the parent exactly once.
  const handledRef = useRef(false);

  function handleBarcodeScanned({ data }: { data: string }) {
    if (handledRef.current) return;
    const code = extractGarageCode(data);
    if (code) {
      handledRef.current = true;
      onScanned(code);
    } else {
      setHint('QR non riconosciuto');
    }
  }

  if (!permission) {
    return (
      <View style={[StyleSheet.absoluteFill, styles.centered]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (!permission.granted && permission.canAskAgain) {
    return (
      <View style={[StyleSheet.absoluteFill, styles.centered]}>
        <Text style={styles.message}>Per scansionare il QR serve l&apos;accesso alla camera.</Text>
        <Pressable onPress={requestPermission} accessibilityRole="button" style={styles.action}>
          <Text style={styles.actionText}>Consenti accesso camera</Text>
        </Pressable>
        <Pressable onPress={onCancel} accessibilityRole="button" style={styles.cancel}>
          <Text style={styles.cancelText}>Annulla</Text>
        </Pressable>
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={[StyleSheet.absoluteFill, styles.centered]}>
        <Text style={styles.message}>Permesso camera negato. Inserisci il codice manualmente.</Text>
        <Pressable
          onPress={() => Linking.openSettings()}
          accessibilityRole="button"
          style={styles.action}
        >
          <Text style={styles.actionText}>Apri impostazioni</Text>
        </Pressable>
        <Pressable onPress={onCancel} accessibilityRole="button" style={styles.cancel}>
          <Text style={styles.cancelText}>Annulla</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={StyleSheet.absoluteFill}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={handleBarcodeScanned}
      />
      <View style={styles.overlay} pointerEvents="box-none">
        <View style={styles.frame} />
        <Text style={styles.scanHint}>Inquadra il QR sul tag del veicolo</Text>
        {hint ? <Text style={styles.scanError}>{hint}</Text> : null}
        <Pressable onPress={onCancel} accessibilityRole="button" style={styles.cancel}>
          <Text style={styles.cancelText}>Annulla</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    backgroundColor: colors.bg,
  },
  message: { color: colors.fg, fontSize: 15, textAlign: 'center' },
  action: {
    backgroundColor: colors.primary,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: 8,
    alignItems: 'center',
  },
  actionText: { color: colors.primaryFg, fontSize: 16, fontWeight: '600' },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
  },
  frame: {
    width: 220,
    height: 220,
    borderWidth: 3,
    borderColor: colors.primaryFg,
    borderRadius: 16,
    backgroundColor: 'transparent',
  },
  scanHint: { color: colors.primaryFg, fontSize: 15, fontWeight: '600' },
  scanError: { color: colors.danger, fontSize: 14, fontWeight: '600' },
  cancel: { alignItems: 'center', padding: spacing.sm },
  cancelText: { color: colors.primary, fontSize: 14 },
});
