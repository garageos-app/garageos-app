import { ScrollView, StyleSheet } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import {
  PrivateInterventionForm,
  type PrivateInterventionFormResult,
} from '@/components/PrivateInterventionForm';
import { useCreatePrivateIntervention } from '@/queries/createPrivateIntervention';
import { ErrorState } from '@/components/ErrorState';
import { ApiError } from '@/lib/api-error';
import type { CreatePrivateInterventionBody } from '@/lib/types/private-intervention';
import { colors } from '@/theme/colors';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function NewPrivateInterventionScreen() {
  const params = useLocalSearchParams<{ vehicleId: string }>();
  const vehicleId =
    typeof params.vehicleId === 'string' && UUID_RE.test(params.vehicleId) ? params.vehicleId : '';
  const router = useRouter();
  const mutation = useCreatePrivateIntervention(vehicleId);

  async function onSubmit(
    body: CreatePrivateInterventionBody,
  ): Promise<PrivateInterventionFormResult> {
    try {
      await mutation.mutateAsync(body);
      router.back();
      return { ok: true };
    } catch (e) {
      if (e instanceof ApiError) return { ok: false, code: e.code };
      return { ok: false, code: 'unknown' };
    }
  }

  if (!vehicleId) {
    return <ErrorState message="Veicolo non valido." />;
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: 'Nuovo intervento' }} />
      <ScrollView style={styles.container} keyboardShouldPersistTaps="handled">
        <PrivateInterventionForm onSubmit={onSubmit} onCancel={() => router.back()} />
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
});
