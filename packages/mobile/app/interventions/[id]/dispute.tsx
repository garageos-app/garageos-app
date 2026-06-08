import { ScrollView, StyleSheet } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { DisputeForm, type DisputeFormResult } from '@/components/DisputeForm';
import { useMeShopInterventionDetail } from '@/queries/meShopInterventionDetail';
import { useCreateDispute } from '@/queries/createDispute';
import { ApiError } from '@/lib/api-error';
import type { CreateDisputeBody } from '@/lib/types/intervention';
import { colors } from '@/theme/colors';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function DisputeScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = typeof params.id === 'string' && UUID_RE.test(params.id) ? params.id : '';
  const router = useRouter();
  const detail = useMeShopInterventionDetail(id);
  const vehicleId = detail.data?.intervention.vehicleId ?? '';
  const create = useCreateDispute(id, vehicleId);

  async function onSubmit(body: CreateDisputeBody): Promise<DisputeFormResult> {
    try {
      await create.mutateAsync(body);
      router.back();
      return { ok: true };
    } catch (e) {
      if (e instanceof ApiError) return { ok: false, code: e.code };
      return { ok: false, code: 'unknown' };
    }
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: 'Contesta intervento' }} />
      <ScrollView style={styles.container} keyboardShouldPersistTaps="handled">
        <DisputeForm onSubmit={onSubmit} onCancel={() => router.back()} />
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
});
