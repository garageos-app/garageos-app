import { useMutation } from '@tanstack/react-query';

import { ApiError, useApiFetch } from '@/lib/api-client';
import type { CreateVehiclePayload } from '@/lib/validators/createVehicle';

// API-only override: confirms a BR-002 duplicate-plate warning.
export type CreateVehicleBody = CreateVehiclePayload & { force?: boolean };

// Projection of the 201 body: the API returns the full vehicle row, but the
// web consumer only reads `id` (redirect target) and `garageCode` (success
// toast) — the new VehicleDetail page re-fetches the full record. We type the
// fields we consume rather than re-declaring the whole Prisma select; extra
// wire fields are ignored by structural typing. Widen here if a caller needs more.
export interface CreateVehicleResponse {
  vehicle: {
    id: string;
    garageCode: string;
    vin: string;
    plate: string;
    make: string;
    model: string;
    year: number;
    status: string;
  };
  customer: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    phone: string | null;
    appInstalled: boolean;
    status: 'active' | 'pending_verification' | 'deleted';
  };
  ownership: { id: string; vehicleId: string; customerId: string; startedAt: string };
  invitation: { id: string; target_email: string; expires_at: string; sent: boolean } | null;
}

/**
 * POST /v1/vehicles (F-OFF-102/103). Side-effect-free: the page owns the
 * success toast (needs garageCode), the duplicate/checksum confirm dialogs,
 * and force/forceNonstandardVin retries.
 */
export function useCreateVehicle() {
  const apiFetch = useApiFetch();
  return useMutation<CreateVehicleResponse, ApiError, CreateVehicleBody>({
    mutationFn: (body) =>
      apiFetch<CreateVehicleResponse>('/v1/vehicles', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  });
}
