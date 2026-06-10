import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  validatePendingVehicleForm,
  type PendingVehicleFormErrors,
} from '@/lib/validators/pendingVehicle';
import { mapErrorToUserMessage } from '@/lib/error-messages';
import type { CreatePendingVehicleRequest } from '@/lib/types/vehicle';
import { colors, spacing } from '@/theme/colors';

export type PendingVehicleFormResult = { ok: true } | { ok: false; code: string };

type Props = {
  onSubmit: (body: CreatePendingVehicleRequest) => Promise<PendingVehicleFormResult>;
  onCancel: () => void;
};

// Enum values mirror the API's vehicle_type / fuel_type enums; labels are the
// Italian user-facing copy (F-CLI-104).
const VEHICLE_TYPE_OPTIONS = [
  { value: 'car', label: 'Auto' },
  { value: 'motorcycle', label: 'Moto' },
  { value: 'van', label: 'Furgone' },
  { value: 'truck', label: 'Camion' },
  { value: 'agricultural', label: 'Mezzo agricolo' },
] as const;

const FUEL_TYPE_OPTIONS = [
  { value: 'petrol', label: 'Benzina' },
  { value: 'diesel', label: 'Diesel' },
  { value: 'electric', label: 'Elettrico' },
  { value: 'hybrid', label: 'Ibrido' },
  { value: 'lpg', label: 'GPL' },
  { value: 'methane', label: 'Metano' },
  { value: 'hydrogen', label: 'Idrogeno' },
  { value: 'other', label: 'Altro' },
] as const;

type ChipOption = { value: string; label: string };

function ChipGroup({
  label,
  group,
  options,
  selected,
  onSelect,
  error,
  disabled,
}: {
  label: string;
  group: string;
  options: readonly ChipOption[];
  selected: string;
  onSelect: (value: string) => void;
  error?: string;
  disabled: boolean;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.chipRow}>
        {options.map((option) => {
          const isSelected = selected === option.value;
          return (
            <Pressable
              key={option.value}
              testID={`chip-${group}-${option.value}`}
              accessibilityRole="button"
              accessibilityState={{ selected: isSelected }}
              disabled={disabled}
              onPress={() => onSelect(option.value)}
              style={[styles.chip, isSelected && styles.chipSelected]}
            >
              <Text style={[styles.chipText, isSelected && styles.chipTextSelected]}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {error ? <Text style={styles.fieldError}>{error}</Text> : null}
    </View>
  );
}

export function PendingVehicleForm({ onSubmit, onCancel }: Props) {
  const [vin, setVin] = useState('');
  const [plate, setPlate] = useState('');
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [year, setYear] = useState('');
  const [vehicleType, setVehicleType] = useState('');
  const [fuelType, setFuelType] = useState('');
  const [errors, setErrors] = useState<PendingVehicleFormErrors>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    if (submitting) return;
    const values = {
      vin: vin.trim().toUpperCase(),
      plate: plate.trim().toUpperCase(),
      make: make.trim(),
      model: model.trim(),
      year: year.trim(),
      vehicleType,
      fuelType,
    };
    const v = validatePendingVehicleForm(values);
    setErrors(v);
    if (Object.keys(v).length > 0) return;
    setBanner(null);

    const body: CreatePendingVehicleRequest = {
      vin: values.vin,
      plate: values.plate,
      make: values.make,
      model: values.model,
      year: parseInt(values.year, 10),
      vehicleType: values.vehicleType,
      fuelType: values.fuelType,
    };

    setSubmitting(true);
    try {
      const result = await onSubmit(body);
      if (result.ok) return; // parent navigates away
      setBanner(mapErrorToUserMessage(result.code));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.hint}>
        {
          'Il veicolo resterà "in attesa di certificazione" finché un\'officina GarageOS non verificherà il libretto.'
        }
      </Text>

      {banner ? (
        <View style={styles.errorBanner} accessibilityRole="alert">
          <Text style={styles.errorText}>{banner}</Text>
        </View>
      ) : null}

      <View style={styles.field}>
        <Text style={styles.label}>Telaio (VIN)</Text>
        <TextInput
          style={styles.input}
          value={vin}
          onChangeText={setVin}
          placeholder="Es. ZFA16900001234567"
          autoCapitalize="characters"
          autoCorrect={false}
          autoComplete="off"
          editable={!submitting}
        />
        {errors.vin ? <Text style={styles.fieldError}>{errors.vin}</Text> : null}
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Targa</Text>
        <TextInput
          style={styles.input}
          value={plate}
          onChangeText={setPlate}
          placeholder="Es. AB123CD"
          autoCapitalize="characters"
          autoCorrect={false}
          autoComplete="off"
          editable={!submitting}
        />
        {errors.plate ? <Text style={styles.fieldError}>{errors.plate}</Text> : null}
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Marca</Text>
        <TextInput
          style={styles.input}
          value={make}
          onChangeText={setMake}
          placeholder="Es. Fiat"
          editable={!submitting}
        />
        {errors.make ? <Text style={styles.fieldError}>{errors.make}</Text> : null}
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Modello</Text>
        <TextInput
          style={styles.input}
          value={model}
          onChangeText={setModel}
          placeholder="Es. Panda"
          editable={!submitting}
        />
        {errors.model ? <Text style={styles.fieldError}>{errors.model}</Text> : null}
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Anno</Text>
        <TextInput
          style={styles.input}
          value={year}
          onChangeText={setYear}
          placeholder="Es. 2018"
          keyboardType="numeric"
          editable={!submitting}
        />
        {errors.year ? <Text style={styles.fieldError}>{errors.year}</Text> : null}
      </View>

      <ChipGroup
        label="Tipo veicolo"
        group="vehicleType"
        options={VEHICLE_TYPE_OPTIONS}
        selected={vehicleType}
        onSelect={setVehicleType}
        error={errors.vehicleType}
        disabled={submitting}
      />

      <ChipGroup
        label="Alimentazione"
        group="fuelType"
        options={FUEL_TYPE_OPTIONS}
        selected={fuelType}
        onSelect={setFuelType}
        error={errors.fuelType}
        disabled={submitting}
      />

      <Pressable
        onPress={handleSubmit}
        testID="pending-vehicle-submit"
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
          <Text style={styles.submitText}>Pre-registra</Text>
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
  hint: { fontSize: 12, color: colors.muted },
  fieldError: { fontSize: 12, color: colors.danger },
  errorBanner: {
    backgroundColor: colors.dangerBg,
    padding: spacing.md,
    borderRadius: 8,
    borderLeftWidth: 4,
    borderLeftColor: colors.danger,
  },
  errorText: { color: colors.danger, fontSize: 13 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    backgroundColor: colors.bg,
  },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 14, fontWeight: '500', color: colors.muted },
  chipTextSelected: { color: colors.primaryFg, fontWeight: '600' },
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
});
