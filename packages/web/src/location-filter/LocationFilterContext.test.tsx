import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import { LocationFilterProvider } from './LocationFilterContext';
import { useLocationFilter } from './useLocationFilter';

const profileRef = { current: { data: undefined as unknown } };
vi.mock('@/queries/profileMe', () => ({
  useProfileMe: () => profileRef.current,
}));

const locationsRef = { current: { data: undefined as unknown } };
const useLocationsMock = vi.fn(() => locationsRef.current);
vi.mock('@/queries/users-admin', () => ({
  useLocations: (opts?: { enabled?: boolean }) => useLocationsMock(opts),
}));

const TENANT = 'tenant-aaaa';
const LOC_A = { id: 'loc-a', name: 'Sede A', isPrimary: true };
const LOC_B = { id: 'loc-b', name: 'Sede B', isPrimary: false };

function wrap({ children }: { children: ReactNode }) {
  return <LocationFilterProvider>{children}</LocationFilterProvider>;
}

describe('LocationFilterProvider', () => {
  beforeEach(() => {
    localStorage.clear();
    useLocationsMock.mockClear();
    profileRef.current = { data: { role: 'super_admin', tenantId: TENANT } };
    locationsRef.current = { data: { locations: [LOC_A, LOC_B] } };
  });

  it('defaults to null (Tutte le sedi) and persists a selection under a tenant-scoped key', () => {
    const { result } = renderHook(() => useLocationFilter(), { wrapper: wrap });
    expect(result.current.selectedLocationId).toBeNull();

    act(() => result.current.setSelectedLocationId('loc-b'));
    expect(result.current.selectedLocationId).toBe('loc-b');
    expect(localStorage.getItem(`garageos:location-filter:${TENANT}`)).toBe('loc-b');
  });

  it('hydrates the persisted selection on mount', async () => {
    localStorage.setItem(`garageos:location-filter:${TENANT}`, 'loc-b');
    const { result } = renderHook(() => useLocationFilter(), { wrapper: wrap });
    await waitFor(() => expect(result.current.selectedLocationId).toBe('loc-b'));
  });

  it('resets to null when the persisted location is no longer active', async () => {
    localStorage.setItem(`garageos:location-filter:${TENANT}`, 'loc-gone');
    const { result } = renderHook(() => useLocationFilter(), { wrapper: wrap });
    await waitFor(() => expect(result.current.selectedLocationId).toBeNull());
    expect(localStorage.getItem(`garageos:location-filter:${TENANT}`)).toBeNull();
  });

  it('does not fetch locations for a mechanic (enabled=false)', () => {
    profileRef.current = { data: { role: 'mechanic', tenantId: TENANT } };
    renderHook(() => useLocationFilter(), { wrapper: wrap });
    expect(useLocationsMock).toHaveBeenCalledWith({ enabled: false });
  });

  it('exposes isSuperAdmin and the active locations', () => {
    const { result } = renderHook(() => useLocationFilter(), { wrapper: wrap });
    expect(result.current.isSuperAdmin).toBe(true);
    expect(result.current.locations.map((l) => l.id)).toEqual(['loc-a', 'loc-b']);
  });
});
