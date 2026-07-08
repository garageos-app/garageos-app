// IT-strings — hardcoded, no i18n in this app
import { useEffect, useState } from 'react';

import { useHasRole } from '@/auth/useHasRole';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { useInterventionTypes } from '@/queries/interventionTypes';
import { useUsers } from '@/queries/users-admin';

import type { InterventionsListParams } from '@/queries/interventionsList';
import { MultiSelectPopover, type MultiSelectOption } from './MultiSelectPopover';

export type InterventionFilterValues = Pick<
  InterventionsListParams,
  'q' | 'status' | 'typeId' | 'checklistItemIds' | 'operatorId' | 'dateFrom' | 'dateTo'
>;

export interface InterventionsFilterBarProps {
  values: InterventionFilterValues;
  onChange: (patch: Partial<InterventionFilterValues>) => void;
}

const STATUS_OPTIONS: MultiSelectOption[] = [
  { value: 'active', label: 'Attivo' },
  { value: 'disputed', label: 'Contestato' },
  { value: 'cancelled', label: 'Cancellato' },
];

// Debounced free-text search bound to the `q` filter. Local state so typing
// stays responsive; the URL (via onChange) updates only after the debounce.
function SearchField({ value, onChange }: { value: string; onChange: (q: string) => void }) {
  const [local, setLocal] = useState(value);
  const debounced = useDebouncedValue(local, 300);

  // Keep local input in sync when the URL changes externally (e.g. reset).
  useEffect(() => {
    setLocal(value);
  }, [value]);

  useEffect(() => {
    // Fire only when the debounced text settles; onChange/value are stable
    // enough for this and are intentionally not in the dependency list.
    if (debounced !== value) onChange(debounced);
  }, [debounced]);

  return (
    <Input
      className="w-64"
      placeholder="Cerca per targa, marca o modello…"
      value={local}
      onChange={(e) => setLocal(e.target.value)}
    />
  );
}

// Operator multiselect — rendered ONLY for super_admins (see Deviation #1 in
// the plan): GET /v1/users is super_admin-gated, so useUsers() runs only when
// this component is mounted for a super_admin.
function OperatorFilter({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const usersQuery = useUsers();
  const options: MultiSelectOption[] = (usersQuery.data?.users ?? [])
    .filter((u) => u.deletedAt === null)
    .map((u) => ({
      value: u.id,
      label: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email,
    }));

  return (
    <MultiSelectPopover
      label="Operatore"
      options={options}
      selected={selected}
      onChange={onChange}
      searchable
      disabled={usersQuery.isPending}
      emptyText="Nessun operatore."
    />
  );
}

export function InterventionsFilterBar({ values, onChange }: InterventionsFilterBarProps) {
  const typesQuery = useInterventionTypes();
  const isSuperAdmin = useHasRole('super_admin');

  const types = typesQuery.data?.data ?? [];
  const typeOptions: MultiSelectOption[] = types.map((t) => ({ value: t.id, label: t.nameIt }));

  // Checklist filter is meaningful only when exactly one type is selected.
  const singleType =
    values.typeId.length === 1 ? types.find((t) => t.id === values.typeId[0]) : undefined;
  const checklistOptions: MultiSelectOption[] = (singleType?.checklistItems ?? []).map((c) => ({
    value: c.id,
    label: c.nameIt,
  }));

  const hasAnyFilter =
    values.q !== '' ||
    values.status.length > 0 ||
    values.typeId.length > 0 ||
    values.checklistItemIds.length > 0 ||
    values.operatorId.length > 0 ||
    values.dateFrom !== '' ||
    values.dateTo !== '';

  return (
    <div className="flex flex-wrap items-center gap-2">
      <SearchField value={values.q} onChange={(q) => onChange({ q })} />

      <MultiSelectPopover
        label="Stato"
        options={STATUS_OPTIONS}
        selected={values.status}
        onChange={(status) => onChange({ status: status as InterventionFilterValues['status'] })}
      />

      <MultiSelectPopover
        label="Tipo"
        options={typeOptions}
        selected={values.typeId}
        // Changing the type set always clears the checklist filter, since the
        // checklist control only exists (and is valid) for a single type.
        onChange={(typeId) => onChange({ typeId, checklistItemIds: [] })}
        searchable
        disabled={typesQuery.isPending}
        emptyText="Nessun tipo."
      />

      {singleType && checklistOptions.length > 0 && (
        <MultiSelectPopover
          label="Voci"
          options={checklistOptions}
          selected={values.checklistItemIds}
          onChange={(checklistItemIds) => onChange({ checklistItemIds })}
          searchable
          emptyText="Nessuna voce."
        />
      )}

      <div className="flex items-center gap-1">
        <label className="text-xs text-muted-foreground" htmlFor="int-date-from">
          Da
        </label>
        <Input
          id="int-date-from"
          type="date"
          className="w-40"
          value={values.dateFrom}
          onChange={(e) => onChange({ dateFrom: e.target.value })}
        />
        <label className="text-xs text-muted-foreground" htmlFor="int-date-to">
          A
        </label>
        <Input
          id="int-date-to"
          type="date"
          className="w-40"
          value={values.dateTo}
          onChange={(e) => onChange({ dateTo: e.target.value })}
        />
      </div>

      {isSuperAdmin && (
        <OperatorFilter
          selected={values.operatorId}
          onChange={(operatorId) => onChange({ operatorId })}
        />
      )}

      {hasAnyFilter && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            onChange({
              q: '',
              status: [],
              typeId: [],
              checklistItemIds: [],
              operatorId: [],
              dateFrom: '',
              dateTo: '',
            })
          }
        >
          Azzera filtri
        </Button>
      )}
    </div>
  );
}
