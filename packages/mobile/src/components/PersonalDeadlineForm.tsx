// Create/edit form for personal vehicle deadlines (F-CLI-306 PR3).
// Pure-presentational: receives `initial`/`submitting`/`serverError` from the
// screen and emits a ready-to-send API body via `onSubmit`. Validation is
// delegated to validatePersonalDeadlineForm (BR-293, BR-294). All user-facing
// strings are in Italian.

import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { format, isValid, parse } from 'date-fns';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';

import { useMeVehiclesList } from '@/queries/meVehicles';
import { CATEGORY_META, LEAD_PRESETS } from '@/lib/personalDeadlineMeta';
import {
  validatePersonalDeadlineForm,
  type PersonalDeadlineFormErrors,
  type PersonalDeadlineFormInput,
} from '@/lib/validators/personalDeadline';
import type {
  CreatePersonalDeadlineBody,
  PersonalDeadlineCategory,
  UpdatePersonalDeadlineBody,
} from '@/lib/types/personalDeadline';
import { colors, spacing } from '@/theme/colors';

type Mode = 'create' | 'edit';

type Props = {
  initial?: Partial<PersonalDeadlineFormInput>;
  submitLabel: string;
  submitting: boolean;
  serverError?: string;
  mode: Mode;
  onSubmit: (body: CreatePersonalDeadlineBody | UpdatePersonalDeadlineBody) => void;
};

// Category display order (matches CATEGORY_META insertion order).
const CATEGORY_ORDER: PersonalDeadlineCategory[] = [
  'insurance',
  'road_tax',
  'inspection',
  'service',
  'tires',
  'timing_belt',
  'other',
];

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function leadLabel(n: number): string {
  return n === 0 ? 'Giorno stesso' : `${n} gg`;
}

export function PersonalDeadlineForm({
  initial,
  submitLabel,
  submitting,
  serverError,
  mode,
  onSubmit,
}: Props) {
  const vehicles = useMeVehiclesList();
  const vehicleList = vehicles.data ?? [];

  const [vehicleId, setVehicleId] = useState(() => {
    if (initial?.vehicleId) return initial.vehicleId;
    return '';
  });
  const [category, setCategory] = useState<PersonalDeadlineCategory>(
    initial?.category ?? 'insurance',
  );
  const [customLabel, setCustomLabel] = useState(initial?.customLabel ?? '');
  const [dueDate, setDueDate] = useState(initial?.dueDate ?? '');
  const [reminderLeadDays, setReminderLeadDays] = useState<number[]>(
    initial?.reminderLeadDays ?? [30, 7, 0],
  );
  const [tailDays, setTailDays] = useState(initial?.reminderDailyTailDays ?? 0);
  const [notifyPush, setNotifyPush] = useState(initial?.notifyPush ?? true);
  const [notifyEmail, setNotifyEmail] = useState(initial?.notifyEmail ?? true);
  const [recurrenceMonths, setRecurrenceMonths] = useState(initial?.recurrenceMonths ?? 0);
  const [notes, setNotes] = useState(initial?.notes ?? '');

  const [errors, setErrors] = useState<PersonalDeadlineFormErrors>({});
  const [showPicker, setShowPicker] = useState(false);

  // Pre-select the only owned vehicle when nothing was provided.
  const effectiveVehicleId =
    vehicleId === '' && !initial?.vehicleId && vehicleList.length === 1
      ? vehicleList[0]!.id
      : vehicleId;

  function parseDueOrToday(value: string): Date {
    const d = parse(value, 'yyyy-MM-dd', new Date());
    return isValid(d) ? d : new Date();
  }

  function handleDateChange(event: DateTimePickerEvent, date?: Date) {
    setShowPicker(false);
    if (event.type !== 'dismissed' && date) {
      setDueDate(format(date, 'yyyy-MM-dd'));
    }
  }

  function toggleLead(n: number) {
    setReminderLeadDays((prev) => (prev.includes(n) ? prev.filter((x) => x !== n) : [...prev, n]));
  }

  function handleSubmit() {
    if (submitting) return;
    const input: PersonalDeadlineFormInput = {
      vehicleId: effectiveVehicleId,
      category,
      customLabel,
      dueDate,
      reminderLeadDays,
      reminderDailyTailDays: tailDays,
      notifyPush,
      notifyEmail,
      recurrenceMonths,
      notes,
    };
    const v = validatePersonalDeadlineForm(input, { allowPastDate: mode === 'edit' });
    setErrors(v);
    if (Object.keys(v).length > 0) return;

    const trimmedLabel = customLabel.trim();
    const trimmedNotes = notes.trim();

    if (mode === 'edit') {
      const body: UpdatePersonalDeadlineBody = {
        category,
        dueDate: dueDate.trim(),
        reminderLeadDays,
        notifyPush,
        notifyEmail,
        customLabel: category === 'other' ? trimmedLabel : null,
        reminderDailyTailDays: tailDays > 0 ? tailDays : null,
        recurrenceMonths: recurrenceMonths > 0 ? recurrenceMonths : null,
        notes: trimmedNotes !== '' ? trimmedNotes : null,
      };
      onSubmit(body);
      return;
    }

    // Create mode: omit cleared optional fields rather than sending null.
    const body: CreatePersonalDeadlineBody = {
      vehicleId: effectiveVehicleId,
      category,
      dueDate: dueDate.trim(),
      reminderLeadDays,
      notifyPush,
      notifyEmail,
    };
    if (category === 'other') body.customLabel = trimmedLabel;
    if (tailDays > 0) body.reminderDailyTailDays = tailDays;
    if (recurrenceMonths > 0) body.recurrenceMonths = recurrenceMonths;
    if (trimmedNotes !== '') body.notes = trimmedNotes;
    onSubmit(body);
  }

  const banner = serverError ?? errors.form;

  return (
    <View style={styles.container}>
      {banner ? (
        <View style={styles.errorBanner} accessibilityRole="alert">
          <Text style={styles.errorText}>{banner}</Text>
        </View>
      ) : null}

      {/* 1. Vehicle */}
      <View style={styles.field}>
        <Text style={styles.label}>Veicolo</Text>
        {vehicles.isLoading ? (
          <Text style={styles.loadingText}>Caricamento veicoli…</Text>
        ) : (
          <View style={styles.chipRow}>
            {vehicleList.map((v) => {
              const selected = v.id === effectiveVehicleId;
              // In edit mode the API has no vehicle-reassign path, so vehicle
              // chips are rendered read-only to avoid a misleading affordance.
              const vehicleDisabled = mode === 'edit';
              return (
                <Pressable
                  key={v.id}
                  testID={`vehicle-chip-${v.id}`}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: vehicleDisabled }}
                  disabled={vehicleDisabled}
                  onPress={() => setVehicleId(v.id)}
                  style={[
                    styles.chip,
                    selected && styles.chipSelected,
                    vehicleDisabled && styles.chipDisabled,
                  ]}
                >
                  <Text style={[styles.chipText, selected && styles.chipTextSelected]}>
                    {`${v.plate} — ${v.make} ${v.model}`}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        )}
        {errors.vehicleId ? <Text style={styles.fieldError}>{errors.vehicleId}</Text> : null}
      </View>

      {/* 2. Category */}
      <View style={styles.field}>
        <Text style={styles.label}>Categoria</Text>
        <View style={styles.chipRow}>
          {CATEGORY_ORDER.map((cat) => {
            const meta = CATEGORY_META[cat];
            const selected = cat === category;
            return (
              <Pressable
                key={cat}
                testID={`category-chip-${cat}`}
                accessibilityRole="button"
                onPress={() => setCategory(cat)}
                style={[styles.chip, styles.chipIcon, selected && styles.chipSelected]}
              >
                <Ionicons
                  name={meta.icon}
                  size={16}
                  color={selected ? colors.primaryFg : colors.fg}
                />
                <Text style={[styles.chipText, selected && styles.chipTextSelected]}>
                  {meta.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* 3. Custom label (only for 'other') */}
      {category === 'other' ? (
        <View style={styles.field}>
          <Text style={styles.label}>Etichetta</Text>
          <TextInput
            testID="custom-label-input"
            style={styles.input}
            value={customLabel}
            onChangeText={setCustomLabel}
            placeholder="Es. Estintore, Tessera autostradale"
            maxLength={80}
            editable={!submitting}
          />
          {errors.customLabel ? <Text style={styles.fieldError}>{errors.customLabel}</Text> : null}
        </View>
      ) : null}

      {/* 4. Due date */}
      <View style={styles.field}>
        <Text style={styles.label}>Scadenza</Text>
        <Pressable
          testID="due-date-field"
          accessibilityRole="button"
          onPress={() => {
            if (!submitting) setShowPicker(true);
          }}
          style={styles.input}
        >
          <Text style={dueDate ? styles.dateText : styles.datePlaceholder}>
            {dueDate ? format(parseDueOrToday(dueDate), 'dd/MM/yyyy') : 'Seleziona data'}
          </Text>
        </Pressable>
        {showPicker ? (
          <DateTimePicker
            testID="due-date-picker"
            value={parseDueOrToday(dueDate)}
            mode="date"
            minimumDate={new Date()}
            onChange={handleDateChange}
          />
        ) : null}
        {errors.dueDate ? <Text style={styles.fieldError}>{errors.dueDate}</Text> : null}
      </View>

      {/* 5. Reminders */}
      <View style={styles.field}>
        <Text style={styles.label}>Promemoria</Text>
        <View style={styles.chipRow}>
          {LEAD_PRESETS.map((n) => {
            const selected = reminderLeadDays.includes(n);
            return (
              <Pressable
                key={n}
                testID={`lead-chip-${n}`}
                accessibilityRole="button"
                onPress={() => toggleLead(n)}
                style={[styles.chip, selected && styles.chipSelected]}
              >
                <Text style={[styles.chipText, selected && styles.chipTextSelected]}>
                  {leadLabel(n)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* 6. Daily tail */}
      <View style={styles.field}>
        <View style={styles.switchRow}>
          <Text style={styles.switchLabel}>Poi ogni giorno negli ultimi giorni</Text>
          <Switch
            testID="tail-toggle"
            value={tailDays > 0}
            onValueChange={(on) => setTailDays(on ? 1 : 0)}
            disabled={submitting}
          />
        </View>
        {tailDays > 0 ? (
          <View style={styles.stepperRow}>
            <Pressable
              testID="tail-stepper-dec"
              accessibilityRole="button"
              onPress={() => setTailDays((d) => clamp(d - 1, 1, 30))}
              style={styles.stepperBtn}
            >
              <Text style={styles.stepperBtnText}>−</Text>
            </Pressable>
            <Text testID="tail-stepper-value" style={styles.stepperValue}>
              {tailDays}
            </Text>
            <Pressable
              testID="tail-stepper-inc"
              accessibilityRole="button"
              onPress={() => setTailDays((d) => clamp(d + 1, 1, 30))}
              style={styles.stepperBtn}
            >
              <Text style={styles.stepperBtnText}>+</Text>
            </Pressable>
            <Text style={styles.stepperUnit}>giorni</Text>
          </View>
        ) : null}
        {errors.reminderDailyTailDays ? (
          <Text style={styles.fieldError}>{errors.reminderDailyTailDays}</Text>
        ) : null}
      </View>

      {/* 7. Channels */}
      <View style={styles.field}>
        <Text style={styles.label}>Canali</Text>
        <View style={styles.switchRow}>
          <Text style={styles.switchLabel}>Notifiche push</Text>
          <Switch
            testID="notify-push"
            value={notifyPush}
            onValueChange={setNotifyPush}
            disabled={submitting}
          />
        </View>
        <View style={styles.switchRow}>
          <Text style={styles.switchLabel}>Email</Text>
          <Switch
            testID="notify-email"
            value={notifyEmail}
            onValueChange={setNotifyEmail}
            disabled={submitting}
          />
        </View>
      </View>

      {/* 8. Recurrence */}
      <View style={styles.field}>
        <View style={styles.switchRow}>
          <Text style={styles.switchLabel}>Si ripete</Text>
          <Switch
            testID="recurrence-toggle"
            value={recurrenceMonths > 0}
            onValueChange={(on) => setRecurrenceMonths(on ? 12 : 0)}
            disabled={submitting}
          />
        </View>
        {recurrenceMonths > 0 ? (
          <View style={styles.stepperRow}>
            <Pressable
              testID="recurrence-stepper-dec"
              accessibilityRole="button"
              onPress={() => setRecurrenceMonths((m) => clamp(m - 1, 1, 120))}
              style={styles.stepperBtn}
            >
              <Text style={styles.stepperBtnText}>−</Text>
            </Pressable>
            <Text testID="recurrence-stepper-value" style={styles.stepperValue}>
              {recurrenceMonths}
            </Text>
            <Pressable
              testID="recurrence-stepper-inc"
              accessibilityRole="button"
              onPress={() => setRecurrenceMonths((m) => clamp(m + 1, 1, 120))}
              style={styles.stepperBtn}
            >
              <Text style={styles.stepperBtnText}>+</Text>
            </Pressable>
            <Text style={styles.stepperUnit}>mesi</Text>
          </View>
        ) : null}
        {errors.recurrenceMonths ? (
          <Text style={styles.fieldError}>{errors.recurrenceMonths}</Text>
        ) : null}
      </View>

      {/* 9. Notes */}
      <View style={styles.field}>
        <Text style={styles.label}>Note</Text>
        <TextInput
          testID="notes-input"
          style={[styles.input, styles.multiline]}
          value={notes}
          onChangeText={setNotes}
          placeholder="Note (opzionale)"
          multiline
          numberOfLines={4}
          maxLength={500}
          editable={!submitting}
        />
        {errors.notes ? <Text style={styles.fieldError}>{errors.notes}</Text> : null}
      </View>

      <Pressable
        testID="submit-button"
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.md, padding: spacing.lg },
  field: { gap: spacing.xs },
  label: { fontSize: 13, fontWeight: '500', color: colors.muted },
  loadingText: { fontSize: 14, color: colors.muted },
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
  datePlaceholder: { fontSize: 16, color: colors.muted },
  multiline: { minHeight: 96, textAlignVertical: 'top' },
  fieldError: { fontSize: 12, color: colors.danger },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.bg,
  },
  chipIcon: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipDisabled: { backgroundColor: colors.mutedBg, borderColor: colors.border, opacity: 0.6 },
  chipText: { fontSize: 14, color: colors.fg },
  chipTextSelected: { color: colors.primaryFg, fontWeight: '600' },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.xs,
  },
  switchLabel: { fontSize: 15, color: colors.fg, flexShrink: 1, paddingRight: spacing.md },
  stepperRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  stepperBtn: {
    width: 40,
    height: 40,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.mutedBg,
  },
  stepperBtnText: { fontSize: 22, color: colors.fg, lineHeight: 24 },
  stepperValue: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.fg,
    minWidth: 32,
    textAlign: 'center',
  },
  stepperUnit: { fontSize: 14, color: colors.muted },
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
});
