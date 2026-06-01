import { createContext, useContext } from 'react';

import type { TenantLocation } from '@/queries/users-admin';

export interface LocationFilterValue {
  /** The sede the super_admin narrowed to, or null = "Tutte le sedi". */
  selectedLocationId: string | null;
  setSelectedLocationId: (id: string | null) => void;
  /** Active locations of the tenant (empty for non-super_admin). */
  locations: TenantLocation[];
  /** True when the caller is a super_admin (the only role that can filter). */
  isSuperAdmin: boolean;
}

export const LocationFilterContext = createContext<LocationFilterValue | null>(null);

export function useLocationFilter(): LocationFilterValue {
  const ctx = useContext(LocationFilterContext);
  if (!ctx) {
    throw new Error('useLocationFilter must be used within a LocationFilterProvider');
  }
  return ctx;
}
