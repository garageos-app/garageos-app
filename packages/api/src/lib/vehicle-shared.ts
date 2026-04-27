import { z } from 'zod';

export const idParamSchema = z.object({
  id: z.uuid(),
});

// Current ownership is the single VehicleOwnership row with
// ended_at IS NULL, enforced by partial unique index
// uq_ownership_vehicle_active (BR-040 — migration
// 20260424100000:190-192). take:1 is defensive in case future rows
// leak through during a transfer window.
export const vehicleOwnershipSelect = {
  where: { endedAt: null },
  select: {
    id: true,
    customerId: true,
    startedAt: true,
    customer: {
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        isBusiness: true,
        businessName: true,
        vatNumber: true,
      },
    },
  },
  take: 1,
} as const;

// Detail shape: all public tech fields + certifiedAt/createdAt. Kept
// in sync by comment only with BR-153 "VISIBILE" — missing fields
// like version/color/displacement are added here explicitly.
export const vehicleDetailSelect = {
  id: true,
  garageCode: true,
  vin: true,
  plate: true,
  plateCountry: true,
  make: true,
  model: true,
  version: true,
  year: true,
  registrationDate: true,
  vehicleType: true,
  fuelType: true,
  engineDisplacement: true,
  powerKw: true,
  color: true,
  status: true,
  certifiedAt: true,
  createdAt: true,
  ownerships: vehicleOwnershipSelect,
} as const;
