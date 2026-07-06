import { useState } from 'react';
import { format, parse, isValid } from 'date-fns';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { Ionicons } from '@expo/vector-icons';
import {
  ALTRO_TYPE_KEY,
  validatePrivateInterventionForm,
  type PrivateInterventionFormErrors,
} from '@/lib/validators/privateIntervention';
import { useMeInterventionTypes } from '@/queries/meInterventionTypes';
import { mapErrorToUserMessage } from '@/lib/error-messages';
import type { CreatePrivateInterventionBody } from '@/lib/types/private-intervention';
import { formatDate } from '@/lib/format';
import { colors, spacing } from '@/theme/colors';

export type PrivateInterventionFormResult =
  | { ok: true }
  | { ok: false; code: string; message?: string };

// Specific Italian copy for the per-field/banner server codes; anything else
// falls back to mapErrorToUserMessage.
const SERVER_MESSAGES: Record<string, string> = {
  'private_intervention.vehicle_not_owned':
    'Puoi registrare interventi solo su veicoli che possiedi.',
  'private_intervention.date_future': 'Non puoi registrare un intervento con data futura.',
  'private_intervention.rate_limit': 'Hai raggiunto il limite giornaliero (50 interventi).',
};

type PrivateInterventionFormInitial = {
  selectedKey: string | null;
  customType: string;
  checklistItemIds: string[];
  interventionDate: string;
  odometerKm: string;
  description: string;
};

type Props = {
  onSubmit: (body: CreatePrivateInterventionBody) => Promise<PrivateInterventionFormResult>;
  onCancel: () => void;
  initial?: PrivateInterventionFormInitial;
  submitLabel?: string;
  onDelete?: () => void;
};

export function PrivateInterventionForm({
  onSubmit,
  onCancel,
  initial,
  submitLabel = 'Salva',
  onDelete,
}: Props) {
  const typesQuery = useMeInterventionTypes();
  const types = typesQuery.data ?? [];

  const [selectedKey, setSelectedKey] = useState<string | null>(initial?.selectedKey ?? null);
  const [checklistItemIds, setChecklistItemIds] = useState<string[]>(
    initial?.checklistItemIds ?? [],
  );
  const [customType, setCustomType] = useState(initial?.customType ?? '');
  const [interventionDate, setInterventionDate] = useState(
    initial?.interventionDate ?? format(new Date(), 'yyyy-MM-dd'),
  );
  const [odometerKm, setOdometerKm] = useState(initial?.odometerKm ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<PrivateInterventionFormErrors>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);

  const isAltro = selectedKey === ALTRO_TYPE_KEY;
  const selectedType =
    selectedKey !== null && !isAltro ? (types.find((t) => t.id === selectedKey) ?? null) : null;

  function parseDateOrToday(value: string): Date {
    const d = parse(value, 'yyyy-MM-dd', new Date());
    return isValid(d) ? d : new Date();
  }

  function handleDateChange(event: DateTimePickerEvent, date?: Date) {
    setShowPicker(false);
    if (event.type !== 'dismissed' && date) {
      setInterventionDate(format(date, 'yyyy-MM-dd'));
    }
  }

  // Selecting a different type clears any prior checklist selection (BR-300
  // parity: the checklist is per-type). Runs only on user tap, so the edit
  // preload (useState initializer) is never clobbered.
  function selectType(key: string) {
    if (key === selectedKey) return;
    setSelectedKey(key);
    setChecklistItemIds([]);
    setErrors((e) => ({
      ...e,
      type: undefined,
      checklistItemIds: undefined,
      customType: undefined,
    }));
  }

  function toggleItem(itemId: string) {
    setChecklistItemIds((prev) =>
      prev.includes(itemId) ? prev.filter((x) => x !== itemId) : [...prev, itemId],
    );
  }

  async function handleSubmit() {
    if (submitting) return;
    const v = validatePrivateInterventionForm({
      selectedKey,
      customType,
      checklistItemIds,
      interventionDate,
      odometerKm,
      description,
    });
    setErrors(v);
    if (Object.keys(v).length > 0) return;
    setBanner(null);

    const km = odometerKm.trim();
    const base = {
      intervention_date: interventionDate.trim(),
      odometer_km: km === '' ? null : Number(km),
      description: description.trim(),
    };

    let body: CreatePrivateInterventionBody;
    if (isAltro) {
      body = { ...base, intervention_type_id: null, custom_type: customType.trim() };
    } else if (selectedKey !== null) {
      body = {
        ...base,
        intervention_type_id: selectedKey,
        custom_type: null,
        checklist_item_ids: checklistItemIds,
      };
    } else {
      return; // unreachable: the validator requires a selection
    }

    setSubmitting(true);
    try {
      const result = await onSubmit(body);
      if (result.ok) return; // parent navigates away
      if (result.code === 'private_intervention.date_future') {
        setErrors({ interventionDate: SERVER_MESSAGES[result.code] });
        return;
      }
      setBanner(
        SERVER_MESSAGES[result.code] ?? result.message ?? mapErrorToUserMessage(result.code),
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View style={styles.container}>
      {banner ? (
        <View style={styles.errorBanner} accessibilityRole="alert">
          <Text style={styles.errorText}>{banner}</Text>
        </View>
      ) : null}

      <View style={styles.field}>
        <Text style={styles.label}>Tipo</Text>
        {typesQuery.isLoading ? (
          <ActivityIndicator testID="type-loading" color={colors.primary} />
        ) : typesQuery.isError ? (
          <Text style={styles.fieldError}>Impossibile caricare i tipi. Riprova.</Text>
        ) : (
          <View style={styles.chipRow}>
            {types.map((t) => {
              const selected = t.id === selectedKey;
              return (
                <Pressable
                  key={t.id}
                  testID={`type-chip-${t.code}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  disabled={submitting}
                  onPress={() => selectType(t.id)}
                  style={[styles.chip, selected && styles.chipSelected]}
                >
                  <Text style={[styles.chipText, selected && styles.chipTextSelected]}>
                    {t.name_it}
                  </Text>
                </Pressable>
              );
            })}
            <Pressable
              testID="type-chip-altro"
              accessibilityRole="button"
              accessibilityState={{ selected: isAltro }}
              disabled={submitting}
              onPress={() => selectType(ALTRO_TYPE_KEY)}
              style={[styles.chip, isAltro && styles.chipSelected]}
            >
              <Text style={[styles.chipText, isAltro && styles.chipTextSelected]}>Altro</Text>
            </Pressable>
          </View>
        )}
        {errors.type ? <Text style={styles.fieldError}>{errors.type}</Text> : null}
      </View>

      {isAltro ? (
        <View style={styles.field}>
          <Text style={styles.label}>Descrizione tipo</Text>
          <TextInput
            style={styles.input}
            value={customType}
            onChangeText={setCustomType}
            placeholder="Es. Lavaggio, Cambio gomme"
            editable={!submitting}
          />
          {errors.customType ? <Text style={styles.fieldError}>{errors.customType}</Text> : null}
        </View>
      ) : null}

      {selectedType ? (
        <View style={styles.field}>
          <Text style={styles.label}>Voci eseguite (almeno una) *</Text>
          {[...selectedType.checklist_items]
            .sort((a, b) => a.sort_order - b.sort_order)
            .map((item) => {
              const checked = checklistItemIds.includes(item.id);
              return (
                <Pressable
                  key={item.id}
                  testID={`checklist-item-${item.code}`}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked }}
                  disabled={submitting}
                  onPress={() => toggleItem(item.id)}
                  style={styles.checklistRow}
                >
                  <Ionicons
                    name={checked ? 'checkbox' : 'square-outline'}
                    size={22}
                    color={checked ? colors.primary : colors.muted}
                  />
                  <Text style={styles.checklistLabel}>{item.name_it}</Text>
                </Pressable>
              );
            })}
          {errors.checklistItemIds ? (
            <Text style={styles.fieldError}>{errors.checklistItemIds}</Text>
          ) : null}
        </View>
      ) : null}

      <View style={styles.field}>
        <Text style={styles.label}>Data</Text>
        <Pressable
          testID="intervention-date-field"
          accessibilityRole="button"
          onPress={() => {
            if (!submitting) setShowPicker(true);
          }}
          style={styles.input}
        >
          <Text style={styles.dateText}>{formatDate(interventionDate)}</Text>
        </Pressable>
        {showPicker ? (
          <DateTimePicker
            testID="intervention-date-picker"
            value={parseDateOrToday(interventionDate)}
            mode="date"
            maximumDate={new Date()}
            onChange={handleDateChange}
          />
        ) : null}
        {errors.interventionDate ? (
          <Text style={styles.fieldError}>{errors.interventionDate}</Text>
        ) : null}
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Chilometri</Text>
        <TextInput
          style={styles.input}
          value={odometerKm}
          onChangeText={setOdometerKm}
          placeholder="Chilometri (opzionale)"
          keyboardType="number-pad"
          editable={!submitting}
        />
        {errors.odometerKm ? <Text style={styles.fieldError}>{errors.odometerKm}</Text> : null}
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Descrizione</Text>
        <TextInput
          style={[styles.input, styles.multiline]}
          value={description}
          onChangeText={setDescription}
          placeholder="Descrizione"
          multiline
          numberOfLines={4}
          editable={!submitting}
        />
        {errors.description ? <Text style={styles.fieldError}>{errors.description}</Text> : null}
      </View>

      <Pressable
        onPress={handleSubmit}
        accessibilityRole="button"
        disabled={submitting}
        style={({ pressed }) => [
          styles.submit,
          pressed && styles.submitPressed,
          submitting && styles.submitDisabled,
        ]}
      >
        {submitting ? (
          <ActivityIndicator color={colors.primaryFg} />
        ) : (
          <Text style={styles.submitText}>{submitLabel}</Text>
        )}
      </Pressable>

      <Pressable
        onPress={onCancel}
        accessibilityRole="button"
        disabled={submitting}
        style={styles.cancel}
      >
        <Text style={styles.cancelText}>Annulla</Text>
      </Pressable>

      {onDelete ? (
        <Pressable
          onPress={onDelete}
          accessibilityRole="button"
          disabled={submitting}
          style={styles.delete}
        >
          <Text style={styles.deleteText}>Elimina</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.md, padding: spacing.lg },
  field: { gap: spacing.xs },
  label: { fontSize: 13, fontWeight: '500', color: colors.muted },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 16,
    color: colors.fg,
    backgroundColor: colors.bg,
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.bg,
  },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 14, color: colors.fg },
  chipTextSelected: { color: colors.primaryFg, fontWeight: '600' },
  checklistRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  checklistLabel: { fontSize: 15, color: colors.fg, flexShrink: 1 },
  dateText: { fontSize: 16, color: colors.fg },
  multiline: { minHeight: 96, textAlignVertical: 'top' },
  fieldError: { fontSize: 12, color: colors.danger },
  errorBanner: {
    backgroundColor: colors.dangerBg,
    padding: spacing.md,
    borderRadius: 8,
    borderLeftWidth: 4,
    borderLeftColor: colors.danger,
  },
  errorText: { color: colors.danger, fontSize: 13 },
  submit: {
    marginTop: spacing.md,
    backgroundColor: colors.primary,
    paddingVertical: spacing.md,
    borderRadius: 8,
    alignItems: 'center',
  },
  submitPressed: { opacity: 0.8 },
  submitDisabled: { backgroundColor: colors.muted },
  submitText: { color: colors.primaryFg, fontSize: 16, fontWeight: '600' },
  cancel: { alignItems: 'center', padding: spacing.sm },
  cancelText: { color: colors.primary, fontSize: 14 },
  delete: { alignItems: 'center', padding: spacing.sm },
  deleteText: { color: colors.danger, fontSize: 14, fontWeight: '600' },
});
