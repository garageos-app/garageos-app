import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { useProfileMe } from '@/queries/profileMe';
import { useLocations } from '@/queries/users-admin';

import { LocationFilterContext, type LocationFilterValue } from './useLocationFilter';

const STORAGE_PREFIX = 'garageos:location-filter:';

function storageKey(tenantId: string): string {
  return `${STORAGE_PREFIX}${tenantId}`;
}

export function LocationFilterProvider({ children }: { children: ReactNode }) {
  const profile = useProfileMe();
  const role = profile.data?.role;
  const tenantId = profile.data?.tenantId;
  const isSuperAdmin = role === 'super_admin';

  // Only super_admin may list locations (the endpoint is super_admin-gated; a
  // mechanic would get a 403). Gate the fetch on the resolved role.
  const locationsQ = useLocations({ enabled: isSuperAdmin });
  const locations = useMemo(() => locationsQ.data?.locations ?? [], [locationsQ.data]);

  const [selectedLocationId, setSelectedLocationIdState] = useState<string | null>(null);

  // Hydrate from localStorage once tenantId is known. Wrapped in try/catch
  // because localStorage can throw (private mode / disabled storage).
  useEffect(() => {
    if (!tenantId || !isSuperAdmin) return;
    try {
      const stored = localStorage.getItem(storageKey(tenantId));
      if (stored) setSelectedLocationIdState(stored);
    } catch {
      // ignore — fall back to "Tutte le sedi"
    }
  }, [tenantId, isSuperAdmin]);

  // Reset to "all" if the persisted location is no longer an active sede
  // (e.g. it was deactivated). Only runs once locations have loaded.
  useEffect(() => {
    if (!selectedLocationId || locations.length === 0) return;
    if (!locations.some((l) => l.id === selectedLocationId)) {
      setSelectedLocationIdState(null);
      if (tenantId) {
        try {
          localStorage.removeItem(storageKey(tenantId));
        } catch {
          // ignore
        }
      }
    }
  }, [selectedLocationId, locations, tenantId]);

  const setSelectedLocationId = useCallback(
    (id: string | null) => {
      setSelectedLocationIdState(id);
      if (!tenantId) return;
      try {
        if (id) localStorage.setItem(storageKey(tenantId), id);
        else localStorage.removeItem(storageKey(tenantId));
      } catch {
        // ignore
      }
    },
    [tenantId],
  );

  const value = useMemo<LocationFilterValue>(
    () => ({ selectedLocationId, setSelectedLocationId, locations, isSuperAdmin }),
    [selectedLocationId, setSelectedLocationId, locations, isSuperAdmin],
  );

  return <LocationFilterContext.Provider value={value}>{children}</LocationFilterContext.Provider>;
}
