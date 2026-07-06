import { Alert, ScrollView, StyleSheet } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import {
  PrivateInterventionForm,
  type PrivateInterventionFormResult,
} from '@/components/PrivateInterventionForm';
import { useMePrivateInterventionDetail } from '@/queries/mePrivateInterventionDetail';
import {
  useDeletePrivateIntervention,
  useUpdatePrivateIntervention,
} from '@/queries/privateInterventionMutations';
import { LoadingState } from '@/components/LoadingState';
import { ErrorState } from '@/components/ErrorState';
import { ApiError } from '@/lib/api-error';
import { mapErrorToUserMessage } from '@/lib/error-messages';
import { ALTRO_TYPE_KEY } from '@/lib/validators/privateIntervention';
import type { CreatePrivateInterventionBody } from '@/lib/types/private-intervention';
import { colors } from '@/theme/colors';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function EditPrivateInterventionScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = typeof params.id === 'string' && UUID_RE.test(params.id) ? params.id : '';
  const router = useRouter();
  const detail = useMePrivateInterventionDetail(id);
  const vehicleId = detail.data?.vehicle_id ?? '';
  const update = useUpdatePrivateIntervention(id, vehicleId);
  const remove = useDeletePrivateIntervention(id, vehicleId);

  async function onSubmit(
    body: CreatePrivateInterventionBody,
  ): Promise<PrivateInterventionFormResult> {
    try {
      await update.mutateAsync(body);
      router.back();
      return { ok: true };
    } catch (e) {
      if (e instanceof ApiError) return { ok: false, code: e.code };
      return { ok: false, code: 'unknown' };
    }
  }

  function onDelete() {
    Alert.alert("Eliminare l'intervento?", "L'operazione non è reversibile.", [
      { text: 'Annulla', style: 'cancel' },
      {
        text: 'Elimina',
        style: 'destructive',
        onPress: () => {
          void remove.mutateAsync().then(
            () => router.back(),
            () => {
              /* stay on screen; error is non-fatal for the smoke flow */
            },
          );
        },
      },
    ]);
  }

  if (!id) return <ErrorState message="Intervento non valido." />;
  if (detail.isLoading) return <LoadingState variant="fullscreen" />;
  if (detail.isError) {
    const code = detail.error instanceof ApiError ? detail.error.code : undefined;
    return <ErrorState message={mapErrorToUserMessage(code)} onRetry={detail.refetch} />;
  }

  const d = detail.data!;
  const initial = {
    // A persisted catalog type wins; else a free-text row maps to "Altro";
    // else nothing is preselected (new-style rows always have one of the two).
    selectedKey: d.type ? d.type.id : d.custom_type ? ALTRO_TYPE_KEY : null,
    customType: d.custom_type ?? '',
    // Non-null snapshot ids only — a deleted catalog item (id null, BR-303
    // SetNull) cannot be re-checked and drops on the next save. Defensive
    // `?? []` guards a stale/partial cache (project memory).
    checklistItemIds: (d.checklist_items ?? [])
      .map((i) => i.id)
      .filter((v): v is string => v !== null),
    interventionDate: d.intervention_date,
    odometerKm: d.odometer_km != null ? String(d.odometer_km) : '',
    description: d.description,
  };

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: 'Modifica intervento' }} />
      <ScrollView style={styles.container} keyboardShouldPersistTaps="handled">
        <PrivateInterventionForm
          initial={initial}
          submitLabel="Salva modifiche"
          onSubmit={onSubmit}
          onCancel={() => router.back()}
          onDelete={onDelete}
        />
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
});
