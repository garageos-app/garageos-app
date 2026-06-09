import { describe, expect, it } from 'vitest';

import { CreateVehiclePayloadSchema } from './createVehicle';

// Backend authoritative schema imported via deep relative path. Dev-time
// only (test file). We deliberately do NOT add @garageos/database as a web
// runtime dep to keep Prisma client out of the Vite bundle. The cross-package
// import sits outside tsconfig.app.json's file list (surfaces as TS6307 under
// tsc -b); Vitest resolves it at test time. Mirror of the parts-replaced
// parity pattern.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore TS6307 cross-package dev-time-only import
import { CreateVehicleSchema as BackendCreateVehicleSchema } from '../../../../database/src/validators/vehicle';

// Canonical valid payload: non-business new customer, standard 17-char VIN.
const canonical = {
  vehicle: {
    vin: '1HGCM82633A004352',
    plate: 'AB123CD',
    make: 'Fiat',
    model: 'Panda',
    year: 2020,
    vehicleType: 'car',
    fuelType: 'petrol',
    odometerKm: 45000,
  },
  customer: {
    mode: 'create_new',
    firstName: 'Mario',
    lastName: 'Rossi',
    email: 'mario@example.it',
    isBusiness: false,
  },
  locationId: '11111111-1111-4111-8111-111111111111',
};

describe('CreateVehiclePayloadSchema parity (web mirror vs backend)', () => {
  it('both accept the canonical payload and produce the same top-level keys', () => {
    const web = CreateVehiclePayloadSchema.safeParse(canonical);
    const backend = BackendCreateVehicleSchema.safeParse(canonical);
    expect(web.success).toBe(true);
    expect(backend.success).toBe(true);
    if (web.success && backend.success) {
      expect(Object.keys(web.data).sort()).toEqual(Object.keys(backend.data).sort());
    }
  });

  it('both reject a payload missing the required odometerKm (drift detection)', () => {
    const noKm = { ...canonical, vehicle: { ...canonical.vehicle } } as Record<string, unknown>;
    delete (noKm.vehicle as Record<string, unknown>).odometerKm;
    expect(CreateVehiclePayloadSchema.safeParse(noKm).success).toBe(false);
    expect(BackendCreateVehicleSchema.safeParse(noKm).success).toBe(false);
  });
});
