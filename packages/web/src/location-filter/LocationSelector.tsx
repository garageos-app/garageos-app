import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import { useLocationFilter } from './useLocationFilter';

// Radix Select forbids an empty-string item value, so "Tutte le sedi" uses
// a sentinel that maps to null (no filter).
const ALL = '__all__';

export function LocationSelector() {
  const { selectedLocationId, setSelectedLocationId, locations, isSuperAdmin } =
    useLocationFilter();

  // BR-205: only a super_admin can filter; for a single-location tenant the
  // selector is pure noise. Render nothing in both cases.
  if (!isSuperAdmin || locations.length < 2) return null;

  return (
    <Select
      value={selectedLocationId ?? ALL}
      onValueChange={(v) => setSelectedLocationId(v === ALL ? null : v)}
    >
      <SelectTrigger aria-label="Sede" className="h-9 w-[200px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>Tutte le sedi</SelectItem>
        {locations.map((loc) => (
          <SelectItem key={loc.id} value={loc.id}>
            {loc.name}
            {loc.isPrimary ? ' (principale)' : ''}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
