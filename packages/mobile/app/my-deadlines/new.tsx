// Create / edit personal-deadline screen (F-CLI-306 PR3). Routes:
//   /my-deadlines/new                      → create
//   /my-deadlines/new?id=<id>              → edit existing deadline
//   /my-deadlines/new?prefill=<json>       → create pre-filled from a renewal
//                                            suggestion (BR-296)
// The screen owns the mutations and navigation; PersonalDeadlineForm owns the
// fields and emits a ready-to-send body. All user-facing strings are Italian.

import { useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import { PersonalDeadlineForm } from '@/components/PersonalDeadlineForm';
import { LoadingState } from '@/components/LoadingState';
import { ErrorState } from '@/components/ErrorState';
import {
  useCreatePersonalDeadline,
  usePersonalDeadline,
  useUpdatePersonalDeadline,
} from '@/queries/personalDeadlines';
import { ApiError } from '@/lib/api-error';
import { mapErrorToUserMessage } from '@/lib/error-messages';
import type { PersonalDeadlineFormInput } from '@/lib/validators/personalDeadline';
import type {
  CreatePersonalDeadlineBody,
  RenewalSuggestion,
  UpdatePersonalDeadlineBody,
} from '@/lib/types/personalDeadline';
import { colors } from '@/theme/colors';

// Build a partial form seed from a renewal-suggestion payload passed via the
// `prefill` query param. Malformed JSON yields an empty seed (handled by caller).
function initialFromPrefill(suggestion: RenewalSuggestion): Partial<PersonalDeadlineFormInput> {
  return {
    dueDate: suggestion.suggestedDueDate,
    category: suggestion.category,
    customLabel: suggestion.customLabel ?? '',
    reminderLeadDays: suggestion.reminderLeadDays,
    reminderDailyTailDays: suggestion.reminderDailyTailDays ?? 0,
    notifyPush: suggestion.notifyPush,
    notifyEmail: suggestion.notifyEmail,
    recurrenceMonths: suggestion.recurrenceMonths,
  };
}

export default function NewPersonalDeadlineScreen() {
  const { id, prefill } = useLocalSearchParams<{ id?: string; prefill?: string }>();
  const router = useRouter();
  const isEdit = typeof id === 'string' && id.length > 0;

  const create = useCreatePersonalDeadline();
  const update = useUpdatePersonalDeadline();
  const detail = usePersonalDeadline(isEdit ? id : '');

  const [serverError, setServerError] = useState<string | undefined>(undefined);

  function errorMessage(err: unknown): string {
    return err instanceof ApiError
      ? mapErrorToUserMessage(err.code)
      : mapErrorToUserMessage(undefined);
  }

  async function handleSubmit(body: CreatePersonalDeadlineBody | UpdatePersonalDeadlineBody) {
    setServerError(undefined);
    try {
      if (isEdit) {
        await update.mutateAsync({ id, body: body as UpdatePersonalDeadlineBody });
        router.back();
      } else {
        const created = await create.mutateAsync(body as CreatePersonalDeadlineBody);
        router.replace(`/my-deadlines/${created.id}`);
      }
    } catch (err) {
      setServerError(errorMessage(err));
    }
  }

  const submitting = create.isPending || update.isPending;
  const submitLabel = isEdit ? 'Salva' : 'Crea scadenza';
  const screenTitle = isEdit ? 'Modifica scadenza' : 'Nuova scadenza';

  // Edit mode: gate render on the loaded detail.
  if (isEdit) {
    if (detail.isError) {
      return (
        <>
          <Stack.Screen options={{ headerShown: true, title: screenTitle }} />
          <ErrorState
            message={mapErrorToUserMessage(
              detail.error instanceof ApiError ? detail.error.code : undefined,
            )}
          />
        </>
      );
    }
    if (detail.isLoading || !detail.data) {
      return (
        <>
          <Stack.Screen options={{ headerShown: true, title: screenTitle }} />
          <LoadingState />
        </>
      );
    }
    const dto = detail.data;
    const initial: Partial<PersonalDeadlineFormInput> = {
      vehicleId: dto.vehicleId,
      dueDate: dto.dueDate,
      category: dto.category,
      customLabel: dto.customLabel ?? '',
      reminderLeadDays: dto.reminderLeadDays,
      reminderDailyTailDays: dto.reminderDailyTailDays ?? 0,
      notifyPush: dto.notifyPush,
      notifyEmail: dto.notifyEmail,
      recurrenceMonths: dto.recurrenceMonths ?? 0,
      notes: dto.notes ?? '',
    };
    return (
      <>
        <Stack.Screen options={{ headerShown: true, title: screenTitle }} />
        <ScrollView style={styles.container} keyboardShouldPersistTaps="handled">
          <PersonalDeadlineForm
            mode="edit"
            initial={initial}
            submitLabel={submitLabel}
            submitting={submitting}
            serverError={serverError}
            onSubmit={(b) => void handleSubmit(b)}
          />
        </ScrollView>
      </>
    );
  }

  // Create mode: optionally seed from the renewal-suggestion prefill.
  let initial: Partial<PersonalDeadlineFormInput> | undefined;
  if (typeof prefill === 'string' && prefill.length > 0) {
    try {
      const parsed = JSON.parse(decodeURIComponent(prefill)) as RenewalSuggestion;
      initial = initialFromPrefill(parsed);
    } catch {
      initial = undefined;
    }
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: screenTitle }} />
      <ScrollView style={styles.container} keyboardShouldPersistTaps="handled">
        <PersonalDeadlineForm
          mode="create"
          initial={initial}
          submitLabel={submitLabel}
          submitting={submitting}
          serverError={serverError}
          onSubmit={(b) => void handleSubmit(b)}
        />
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
});
