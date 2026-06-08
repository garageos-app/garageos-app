import { ScrollView, StyleSheet } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { ClaimVehicleForm, type ClaimVehicleFormResult } from '@/components/ClaimVehicleForm';
import { useClaimVehicle } from '@/queries/claimVehicle';
import { GARAGE_CODE_RE } from '@/lib/validators/claimVehicle';
import { ApiError } from '@/lib/api-error';
import { colors } from '@/theme/colors';

export default function ClaimVehicleScreen() {
  const router = useRouter();
  const mutation = useClaimVehicle();
  // A deep-link (app/v/[code].tsx) or post-login redirect lands here with the
  // GarageOS code in ?code. Pre-fill only a well-formed code (BR-020); the form
  // and server re-validate regardless.
  const { code } = useLocalSearchParams<{ code?: string }>();
  const normalized = code?.trim().toUpperCase();
  const initialCode = normalized && GARAGE_CODE_RE.test(normalized) ? normalized : undefined;

  async function onSubmit(garageCode: string): Promise<ClaimVehicleFormResult> {
    try {
      const res = await mutation.mutateAsync({ garageCode });
      // Both 'claimed' and 'already_owned' are HTTP 200: the vehicle is now/was
      // already the customer's. Land on its detail; replace so back returns to
      // the list, not to this form.
      router.replace(`/(tabs)/vehicles/${res.vehicle.id}`);
      return { ok: true };
    } catch (e) {
      if (e instanceof ApiError) return { ok: false, code: e.code };
      return { ok: false, code: 'unknown' };
    }
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: 'Aggiungi veicolo' }} />
      <ScrollView style={styles.container} keyboardShouldPersistTaps="handled">
        <ClaimVehicleForm
          onSubmit={onSubmit}
          onCancel={() => router.back()}
          initialCode={initialCode}
        />
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
});
