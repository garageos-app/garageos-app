import { ScrollView, StyleSheet } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { PendingVehicleForm, type PendingVehicleFormResult } from '@/components/PendingVehicleForm';
import { useCreatePendingVehicle } from '@/queries/pendingVehicle';
import { ApiError } from '@/lib/api-error';
import type { CreatePendingVehicleRequest } from '@/lib/types/vehicle';
import { colors } from '@/theme/colors';

// Customer pre-registration of a vehicle awaiting workshop certification
// (F-CLI-104). Mirrors claim-vehicle.tsx: standalone route, adapter maps
// ApiError → { ok: false, code } for the form's Italian banner.
export default function PendingVehicleScreen() {
  const router = useRouter();
  const mutation = useCreatePendingVehicle();

  async function onSubmit(body: CreatePendingVehicleRequest): Promise<PendingVehicleFormResult> {
    try {
      const res = await mutation.mutateAsync(body);
      // Land on the new vehicle's detail; replace so back returns to the
      // previous screen, not to this form.
      router.replace(`/(tabs)/vehicles/${res.vehicle.id}`);
      return { ok: true };
    } catch (e) {
      if (e instanceof ApiError) return { ok: false, code: e.code };
      return { ok: false, code: 'unknown' };
    }
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: 'Pre-registra veicolo' }} />
      <ScrollView style={styles.container} keyboardShouldPersistTaps="handled">
        <PendingVehicleForm onSubmit={onSubmit} onCancel={() => router.back()} />
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
});
