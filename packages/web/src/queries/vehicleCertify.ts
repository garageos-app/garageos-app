import { useMutation, useQueryClient } from '@tanstack/react-query';

import { ApiError, useApiFetch } from '@/lib/api-client';
import type { FuelType, VehicleType } from '@/lib/validators/createVehicle';

// Wire mirror of the backend CertifyVehicleSchema
// (packages/database/src/validators/vehicle.ts) — POST /v1/vehicles/:id/certify,
// F-OFF-107 / BR-004. `corrections` carries ONLY the fields the mechanic
// changed against the libretto; override flags mirror F-OFF-102.
export interface CertifyVehicleCorrections {
  vin?: string;
  plate?: string;
  plateCountry?: string;
  make?: string;
  model?: string;
  version?: string | null;
  year?: number;
  registrationDate?: string | null;
  vehicleType?: VehicleType;
  fuelType?: FuelType;
}

export interface CertifyVehicleBody {
  librettoVisioned: boolean;
  corrections?: CertifyVehicleCorrections;
  forceNonstandardVin?: boolean;
  force?: boolean;
}

// Projection of the 200 body ({vehicle, currentOwnership}, same shape as
// PATCH /vehicles/:id): the dialog only reads garageCode for the success
// toast — the detail page re-fetches via invalidation.
export interface CertifyVehicleResponse {
  vehicle: { id: string; garageCode: string; status: string };
}

/**
 * POST /v1/vehicles/:id/certify (F-OFF-107). Side-effect-free on errors:
 * the dialog owns the success toast (needs garageCode) and the
 * duplicate-plate / VIN-checksum confirm retries.
 */
export function useCertifyVehicle(vehicleId: string) {
  const apiFetch = useApiFetch();
  const qc = useQueryClient();
  return useMutation<CertifyVehicleResponse, ApiError, CertifyVehicleBody>({
    mutationFn: (body) =>
      apiFetch<CertifyVehicleResponse>(`/v1/vehicles/${vehicleId}/certify`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['vehicle-detail', vehicleId] });
      void qc.invalidateQueries({ queryKey: ['vehicle-search'] });
    },
  });
}
