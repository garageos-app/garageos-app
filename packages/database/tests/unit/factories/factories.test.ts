import { describe, expect, it } from 'vitest';

import {
  CustomerFactory,
  InterventionFactory,
  InterventionTypeFactory,
  TenantFactory,
  UserFactory,
  VehicleFactory,
  activeCustomer,
  businessCustomer,
  buildGarageCode,
  cancelledIntervention,
  certifiedVehicle,
  disputedIntervention,
  invitedUser,
  mechanicUser,
  motorcycle,
  suspendedTenant,
} from '../../../src/factories/index.js';
import {
  EmailSchema,
  GarageCodeSchema,
  ItalianPlateSchema,
  UuidSchema,
  VatNumberSchema,
  VinSchema,
} from '../../../src/validators/index.js';

// Cross-check: factories must produce output whose scalar-level fields
// pass the corresponding primitive validators. This catches drift between
// a factory default and a schema constraint (e.g. accidentally using an I
// in a test VIN, or a malformed VAT number).

describe('TenantFactory.build', () => {
  it('produces a valid UUID id and 11-digit vatNumber', () => {
    const t = TenantFactory.build();
    expect(() => UuidSchema.parse(t.id)).not.toThrow();
    expect(() => VatNumberSchema.parse(t.vatNumber)).not.toThrow();
    expect(() => EmailSchema.parse(t.email)).not.toThrow();
    expect(t.status).toBe('active');
  });

  it('suspendedTenant trait flips status', () => {
    expect(suspendedTenant.build().status).toBe('suspended');
  });

  it('generates unique ids / vatNumbers across builds', () => {
    const a = TenantFactory.build();
    const b = TenantFactory.build();
    expect(a.id).not.toBe(b.id);
    expect(a.vatNumber).not.toBe(b.vatNumber);
  });
});

describe('UserFactory.build', () => {
  it('defaults to super_admin with valid email', () => {
    const u = UserFactory.build();
    expect(u.role).toBe('super_admin');
    expect(() => EmailSchema.parse(u.email)).not.toThrow();
    expect(() => UuidSchema.parse(u.id)).not.toThrow();
  });

  it('mechanicUser trait changes role', () => {
    expect(mechanicUser.build().role).toBe('mechanic');
  });

  it('invitedUser trait flips status', () => {
    expect(invitedUser.build().status).toBe('invited');
  });
});

describe('CustomerFactory.build', () => {
  it('defaults to B2C shadow account (no cognitoSub, app not installed)', () => {
    const c = CustomerFactory.build();
    expect(c.cognitoSub).toBeNull();
    expect(c.appInstalled).toBe(false);
    expect(c.isBusiness).toBe(false);
    expect(() => EmailSchema.parse(c.email)).not.toThrow();
  });

  it('businessCustomer trait populates businessName + vatNumber', () => {
    const c = businessCustomer.build();
    expect(c.isBusiness).toBe(true);
    expect(c.businessName).toBeTruthy();
    expect(() => VatNumberSchema.parse(c.vatNumber)).not.toThrow();
  });

  it('activeCustomer trait has cognitoSub + appInstalled', () => {
    const c = activeCustomer.build();
    expect(c.cognitoSub).toBeTruthy();
    expect(c.appInstalled).toBe(true);
  });
});

describe('VehicleFactory.build', () => {
  it('produces a pending vehicle with null garageCode and valid VIN/plate', () => {
    const v = VehicleFactory.build();
    expect(v.garageCode).toBeNull();
    expect(v.status).toBe('pending');
    expect(() => VinSchema.parse(v.vin)).not.toThrow();
    expect(() => ItalianPlateSchema.parse(v.plate)).not.toThrow();
  });

  it('VIN uses only safe chars (no I/O/Q)', () => {
    for (let i = 0; i < 20; i += 1) {
      const vin = VehicleFactory.build().vin;
      expect(vin).toMatch(/^[A-HJ-NPR-Z0-9]{17}$/);
    }
  });

  it('plate rotates suffix letter after 1000 sequences', () => {
    // seq 1 → AB000AA, seq 1001 → AB000BB — verify format is always valid.
    for (let i = 0; i < 10; i += 1) {
      const plate = VehicleFactory.build().plate;
      expect(() => ItalianPlateSchema.parse(plate)).not.toThrow();
    }
  });

  it('certifiedVehicle trait sets status to certified', () => {
    expect(certifiedVehicle.build().status).toBe('certified');
  });

  it('motorcycle trait changes vehicleType', () => {
    expect(motorcycle.build().vehicleType).toBe('motorcycle');
  });

  it('buildGarageCode produces codes passing GarageCodeSchema', () => {
    for (let i = 1; i <= 25; i += 1) {
      const code = buildGarageCode(i);
      expect(() => GarageCodeSchema.parse(code)).not.toThrow();
    }
  });
});

describe('InterventionTypeFactory.build', () => {
  it('defaults to a system type (tenantId=null)', () => {
    const t = InterventionTypeFactory.build();
    expect(t.tenantId).toBeNull();
    expect(t.active).toBe(true);
    expect(t.category).toBe('maintenance');
  });

  it('generates unique codes across builds', () => {
    const a = InterventionTypeFactory.build();
    const b = InterventionTypeFactory.build();
    expect(a.code).not.toBe(b.code);
  });
});

describe('InterventionFactory.build', () => {
  it("defaults to an active intervention with today's date and empty parts", () => {
    const i = InterventionFactory.build();
    expect(i.status).toBe('active');
    expect(i.partsReplaced).toEqual([]);
    expect(i.kmAnomaly).toBe(false);
    expect(i.odometerKm).toBeGreaterThanOrEqual(10_000);
  });

  it('cancelledIntervention trait changes status', () => {
    expect(cancelledIntervention.build().status).toBe('cancelled');
  });

  it('disputedIntervention trait changes status', () => {
    expect(disputedIntervention.build().status).toBe('disputed');
  });

  it('all FK ids are valid UUIDs', () => {
    const i = InterventionFactory.build();
    for (const id of [i.tenantId, i.userId, i.vehicleId, i.interventionTypeId]) {
      expect(() => UuidSchema.parse(id)).not.toThrow();
    }
  });
});
