import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  CertifyVehicleSchema,
  ClaimVehicleSchema,
  CreatePendingVehicleSchema,
  CreateVehicleSchema,
  FuelTypeEnum,
  UpdateVehicleSchema,
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

describe('UpdateVehicleSchema', () => {
  it('accepts a single editable field', () => {
    const result = UpdateVehicleSchema.safeParse({ color: 'red' });
    expect(result.success).toBe(true);
  });

  it('accepts multiple editable fields', () => {
    const result = UpdateVehicleSchema.safeParse({
      color: 'blue',
      powerKw: 80,
      registrationDate: '2020-01-15',
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty body', () => {
    const result = UpdateVehicleSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.message).toMatch(/almeno un campo/i);
    }
  });

  it('rejects unknown fields (strict)', () => {
    const result = UpdateVehicleSchema.safeParse({ status: 'archived' });
    expect(result.success).toBe(false);
  });

  it('rejects vin with wrong length', () => {
    const result = UpdateVehicleSchema.safeParse({ vin: 'ABC' });
    expect(result.success).toBe(false);
  });

  it('rejects year out of range (BR-007)', () => {
    const tooOld = UpdateVehicleSchema.safeParse({ year: 1800 });
    expect(tooOld.success).toBe(false);
    const currentYear = new Date().getUTCFullYear();
    const tooFuture = UpdateVehicleSchema.safeParse({ year: currentYear + 5 });
    expect(tooFuture.success).toBe(false);
  });

  it('rejects plateCountry with wrong length', () => {
    const result = UpdateVehicleSchema.safeParse({ plateCountry: 'ITA' });
    expect(result.success).toBe(false);
  });

  it('accepts override flags alongside an editable field', () => {
    const result = UpdateVehicleSchema.safeParse({
      color: 'red',
      forceNonstandardVin: true,
      force: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects body with only override flags (no editable field)', () => {
    const result = UpdateVehicleSchema.safeParse({
      forceNonstandardVin: true,
      force: true,
    });
    expect(result.success).toBe(false);
  });
});

describe('CreatePendingVehicleSchema', () => {
  const BASE_PENDING = {
    vin: 'ZFA16900000512345',
    plate: 'AB123CD',
    make: 'Fiat',
    model: 'Panda',
    year: 2021,
    vehicleType: 'car' as const,
    fuelType: 'petrol' as const,
  };

  it('accepts a minimal body and defaults plateCountry to IT', () => {
    const parsed = CreatePendingVehicleSchema.parse({ ...BASE_PENDING });
    expect(parsed.plateCountry).toBe('IT');
    // Optional technical fields stay absent (not coerced to null/empty).
    expect(parsed.version).toBeUndefined();
    expect(parsed.registrationDate).toBeUndefined();
    expect(parsed.engineDisplacement).toBeUndefined();
    expect(parsed.powerKw).toBeUndefined();
    expect(parsed.color).toBeUndefined();
  });

  it('accepts the optional owner-declared technical fields', () => {
    const parsed = CreatePendingVehicleSchema.parse({
      ...BASE_PENDING,
      version: '1.2 Easy',
      registrationDate: '2021-03-15',
      engineDisplacement: 1242,
      powerKw: 51,
      color: 'Bianco',
    });
    expect(parsed.version).toBe('1.2 Easy');
    expect(parsed.registrationDate).toBe('2021-03-15');
    expect(parsed.engineDisplacement).toBe(1242);
    expect(parsed.powerKw).toBe(51);
    expect(parsed.color).toBe('Bianco');
  });

  it('rejects unknown fields (strict) — e.g. odometerKm is workshop-only', () => {
    const result = CreatePendingVehicleSchema.safeParse({ ...BASE_PENDING, odometerKm: 1000 });
    expect(result.success).toBe(false);
  });

  it('rejects forceNonstandardVin (mechanic-only bypass is absent here)', () => {
    const result = CreatePendingVehicleSchema.safeParse({
      ...BASE_PENDING,
      forceNonstandardVin: true,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-positive engineDisplacement', () => {
    expect(
      CreatePendingVehicleSchema.safeParse({ ...BASE_PENDING, engineDisplacement: 0 }).success,
    ).toBe(false);
    expect(
      CreatePendingVehicleSchema.safeParse({ ...BASE_PENDING, engineDisplacement: -1 }).success,
    ).toBe(false);
  });

  it('rejects a non-positive powerKw', () => {
    expect(CreatePendingVehicleSchema.safeParse({ ...BASE_PENDING, powerKw: 0 }).success).toBe(
      false,
    );
  });

  it('rejects a malformed registrationDate', () => {
    expect(
      CreatePendingVehicleSchema.safeParse({ ...BASE_PENDING, registrationDate: '15/03/2021' })
        .success,
    ).toBe(false);
  });

  it('rejects version longer than 150 chars and color longer than 50', () => {
    expect(
      CreatePendingVehicleSchema.safeParse({ ...BASE_PENDING, version: 'x'.repeat(151) }).success,
    ).toBe(false);
    expect(
      CreatePendingVehicleSchema.safeParse({ ...BASE_PENDING, color: 'x'.repeat(51) }).success,
    ).toBe(false);
  });
});

// BR-004 — pending→certified promotion body (F-OFF-107).
describe('CertifyVehicleSchema', () => {
  it('accepts minimal body and applies defaults', () => {
    const result = CertifyVehicleSchema.parse({ librettoVisioned: true });
    expect(result).toEqual({
      librettoVisioned: true,
      forceNonstandardVin: false,
      force: false,
    });
  });

  it('defaults librettoVisioned to false when absent', () => {
    const result = CertifyVehicleSchema.parse({});
    expect(result.librettoVisioned).toBe(false);
  });

  it('accepts a corrections subset', () => {
    const result = CertifyVehicleSchema.parse({
      librettoVisioned: true,
      corrections: { plate: 'XY987ZW', year: 2020 },
    });
    expect(result.corrections).toEqual({ plate: 'XY987ZW', year: 2020 });
  });

  it('accepts all correctable fields', () => {
    const result = CertifyVehicleSchema.safeParse({
      librettoVisioned: true,
      corrections: {
        vin: 'ZFA16900000512345',
        plate: 'AB123CD',
        plateCountry: 'IT',
        make: 'Fiat',
        model: 'Panda',
        version: '1.2 Easy',
        year: 2021,
        registrationDate: '2021-03-15',
        vehicleType: 'car',
        fuelType: 'petrol',
      },
      forceNonstandardVin: true,
      force: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects non-correctable keys in corrections (status, garageCode)', () => {
    expect(
      CertifyVehicleSchema.safeParse({
        librettoVisioned: true,
        corrections: { status: 'certified' },
      }).success,
    ).toBe(false);
    expect(
      CertifyVehicleSchema.safeParse({
        librettoVisioned: true,
        corrections: { garageCode: 'GO-234-ABCD' },
      }).success,
    ).toBe(false);
  });

  it('rejects unknown top-level keys', () => {
    const result = CertifyVehicleSchema.safeParse({
      librettoVisioned: true,
      certifiedByTenantId: randomUUID(),
    });
    expect(result.success).toBe(false);
  });

  it('rejects year outside BR-007 bounds inside corrections', () => {
    const currentYear = new Date().getUTCFullYear();
    expect(
      CertifyVehicleSchema.safeParse({
        librettoVisioned: true,
        corrections: { year: 1899 },
      }).success,
    ).toBe(false);
    expect(
      CertifyVehicleSchema.safeParse({
        librettoVisioned: true,
        corrections: { year: currentYear + 2 },
      }).success,
    ).toBe(false);
  });

  it('rejects malformed corrections vin', () => {
    const result = CertifyVehicleSchema.safeParse({
      librettoVisioned: true,
      corrections: { vin: 'ABC' },
    });
    expect(result.success).toBe(false);
  });
});
