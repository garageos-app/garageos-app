import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { ApiError, useApiFetch } from '@/lib/api-client';
import { translateError } from '@/lib/error-messages';

// useLocations + TenantLocation already live in users-admin.ts (shared with
// the user-invite flow). Re-export so location features import from one place.
export { useLocations, type TenantLocation } from './users-admin';

import type { TenantLocation } from './users-admin';

export interface LocationWriteBody {
  name: string;
  addressLine: string;
  city: string;
  province: string;
  postalCode: string;
  country: string;
  phone: string | null;
  email: string | null;
}

export type UpdateLocationBody = Partial<LocationWriteBody> & { isPrimary?: boolean };

interface LocationResponse {
  location: TenantLocation;
}

/** POST /v1/tenants/me/locations — create a secondary location. */
export function useCreateLocation() {
  const apiFetch = useApiFetch();
  const qc = useQueryClient();
  return useMutation<LocationResponse, ApiError, LocationWriteBody>({
    mutationFn: (body) =>
      apiFetch<LocationResponse>('/v1/tenants/me/locations', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tenant-locations'] });
      toast.success('Sede creata');
    },
    onError: (err) => {
      toast.error(translateError(err.code, err.message));
    },
  });
}

/** PATCH /v1/tenants/me/locations/:id — edit fields and/or promote to primary. */
export function useUpdateLocation() {
  const apiFetch = useApiFetch();
  const qc = useQueryClient();
  return useMutation<LocationResponse, ApiError, { id: string; body: UpdateLocationBody }>({
    mutationFn: ({ id, body }) =>
      apiFetch<LocationResponse>(`/v1/tenants/me/locations/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tenant-locations'] });
      toast.success('Sede aggiornata');
    },
    onError: (err) => {
      toast.error(translateError(err.code, err.message));
    },
  });
}

/** DELETE /v1/tenants/me/locations/:id — soft-delete (deactivate) a location. */
export function useDeleteLocation() {
  const apiFetch = useApiFetch();
  const qc = useQueryClient();
  return useMutation<void, ApiError, string>({
    // body: '{}' — apiFetch hardcodes Content-Type: application/json and
    // Fastify rejects that header with no body (see users-admin.ts:206).
    mutationFn: (id) =>
      apiFetch<void>(`/v1/tenants/me/locations/${id}`, { method: 'DELETE', body: '{}' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tenant-locations'] });
      toast.success('Sede disattivata');
    },
    onError: (err) => {
      toast.error(translateError(err.code, err.message));
    },
  });
}
