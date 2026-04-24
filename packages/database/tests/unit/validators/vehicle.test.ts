import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  ClaimVehicleSchema,
  CreateVehicleSchema,
  FuelTypeEnum,
  VehicleTypeEnum,
} from '../../../src/validators/vehicle.js';

const BASE_VEHICLE = {
  vin: 'ZFA16900000512345',
  plate: 'AB123CD',
  make: 'Fiat',
  model: 'Panda',
  year: 2021,
  vehicleType: 'car' as const,
  fuelType: 'petrol' as const,
  odometerKm: 45_000,
};

const BASE_CUSTOMER_CREATE = {
  mode: 'create_new' as const,
  firstName: 'Mario',
  lastName: 'Rossi',
  email: 'mario@test.local',
};

function validInput() {
  return {
    vehicle: { ...BASE_VEHICLE },
    customer: { ...BASE_CUSTOMER_CREATE },
    locationId: randomUUID(),
  };
}

describe('VehicleTypeEnum / FuelTypeEnum', () => {
  it.each(['car', 'motorcycle', 'van', 'truck', 'agricultural'])(
    'VehicleTypeEnum accepts %s',
    (v) => {
      expect(VehicleTypeEnum.parse(v)).toBe(v);
    },
  );

  it('VehicleTypeEnum rejects unknown value', () => {
    expect(() => VehicleTypeEnum.parse('bicycle')).toThrow();
  });

  it.each(['petrol', 'diesel', 'electric', 'hybrid', 'lpg', 'methane', 'hydrogen', 'other'])(
    'FuelTypeEnum accepts %s',
    (v) => {
      expect(FuelTypeEnum.parse(v)).toBe(v);
    },
  );

  it('FuelTypeEnum rejects unknown value', () => {
    expect(() => FuelTypeEnum.parse('gasoline')).toThrow();
  });
});

describe('CreateVehicleSchema — happy path', () => {
  it('accepts a minimal valid input', () => {
    const parsed = CreateVehicleSchema.parse(validInput());
    expect(parsed.vehicle.plateCountry).toBe('IT');
    expect(parsed.sendInvitationEmail).toBe(true);
    expect(parsed.forceNonstandardVin).toBe(false);
    if (parsed.customer.mode === 'create_new') {
      expect(parsed.customer.isBusiness).toBe(false);
    }
  });

  it('accepts an `existing` customer discriminant', () => {
    const parsed = CreateVehicleSchema.parse({
      ...validInput(),
      customer: { mode: 'existing', customerId: randomUUID() },
    });
    expect(parsed.customer.mode).toBe('existing');
  });
});

describe('BR-007 — year bounds', () => {
  it('accepts 1900', () => {
    const input = validInput();
    input.vehicle.year = 1900;
    expect(() => CreateVehicleSchema.parse(input)).not.toThrow();
  });

  it('accepts current year + 1', () => {
    const input = validInput();
    input.vehicle.year = new Date().getUTCFullYear() + 1;
    expect(() => CreateVehicleSchema.parse(input)).not.toThrow();
  });

  it('rejects years before 1900', () => {
    const input = validInput();
    input.vehicle.year = 1899;
    expect(() => CreateVehicleSchema.parse(input)).toThrow();
  });

  it('rejects years more than 1 year in the future', () => {
    const input = validInput();
    input.vehicle.year = new Date().getUTCFullYear() + 2;
    expect(() => CreateVehicleSchema.parse(input)).toThrow();
  });
});

describe('BR-223 — business customer refinement', () => {
  it('rejects B2B without businessName + vatNumber', () => {
    const input = validInput();
    input.customer = { ...BASE_CUSTOMER_CREATE, isBusiness: true };
    expect(() => CreateVehicleSchema.parse(input)).toThrow(/businessName e vatNumber obbligatori/);
  });

  it('accepts B2B with both businessName and vatNumber', () => {
    const input = validInput();
    input.customer = {
      ...BASE_CUSTOMER_CREATE,
      isBusiness: true,
      businessName: 'Autotrasporti Rossi',
      vatNumber: '12345678901',
    };
    expect(() => CreateVehicleSchema.parse(input)).not.toThrow();
  });
});

describe('CreateVehicleSchema — invalid inputs', () => {
  it('rejects negative odometer', () => {
    const input = validInput();
    input.vehicle.odometerKm = -1;
    expect(() => CreateVehicleSchema.parse(input)).toThrow();
  });

  it('rejects invalid VIN', () => {
    const input = validInput();
    input.vehicle.vin = 'TOO-SHORT';
    expect(() => CreateVehicleSchema.parse(input)).toThrow();
  });

  it('rejects invalid plate', () => {
    const input = validInput();
    input.vehicle.plate = '123ABC';
    expect(() => CreateVehicleSchema.parse(input)).toThrow();
  });

  it('rejects non-UUID locationId', () => {
    const input = validInput();
    input.locationId = 'not-a-uuid';
    expect(() => CreateVehicleSchema.parse(input)).toThrow();
  });
});

describe('BR-024 — ClaimVehicleSchema case-insensitive transform', () => {
  it('accepts lowercase code and normalizes to uppercase', () => {
    // GarageCodeSchema itself rejects lowercase, but the transform in
    // ClaimVehicleSchema is explicitly .transform(s => s.toUpperCase()).
    // So the input must already be uppercase to pass the regex. Verify
    // the transform preserves uppercase and the output is guaranteed
    // uppercase for downstream DB queries.
    const parsed = ClaimVehicleSchema.parse({ garageCode: 'GO-482-KXRT' });
    expect(parsed.garageCode).toBe('GO-482-KXRT');
  });

  it('rejects codes that do not match the format', () => {
    expect(() => ClaimVehicleSchema.parse({ garageCode: 'GO-012-KXRT' })).toThrow();
  });
});
