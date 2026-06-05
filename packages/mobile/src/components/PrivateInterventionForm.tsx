import { useState } from 'react';
import { format, parse, isValid } from 'date-fns';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import {
  validatePrivateInterventionForm,
  type PrivateInterventionFormErrors,
} from '@/lib/validators/privateIntervention';
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
  customType: string;
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

  async function handleSubmit() {
    if (submitting) return;
    const v = validatePrivateInterventionForm({
      customType,
      interventionDate,
      odometerKm,
      description,
    });
    setErrors(v);
    if (Object.keys(v).length > 0) return;
    setBanner(null);

    const km = odometerKm.trim();
    const body: CreatePrivateInterventionBody = {
      intervention_date: interventionDate.trim(),
      odometer_km: km === '' ? null : Number(km),
      intervention_type_id: null,
      custom_type: customType.trim(),
      description: description.trim(),
    };

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
        <TextInput
          style={styles.input}
          value={customType}
          onChangeText={setCustomType}
          placeholder="Es. Lavaggio, Cambio gomme"
          editable={!submitting}
        />
        {errors.customType ? <Text style={styles.fieldError}>{errors.customType}</Text> : null}
      </View>

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
