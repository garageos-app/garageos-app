import {
  validatePendingVehicleForm,
  type PendingVehicleFormValues,
} from '@/lib/validators/pendingVehicle';

// Already-normalized values (the form trims + uppercases before calling).
// Optional technical fields default to '' = "not provided".
function values(overrides: Partial<PendingVehicleFormValues> = {}): PendingVehicleFormValues {
  return {
    vin: 'ZFA16900001234567',
    plate: 'AB123CD',
    make: 'Fiat',
    model: 'Panda',
    year: '2018',
    vehicleType: 'car',
    fuelType: 'petrol',
    version: '',
    registrationDate: '',
    engineDisplacement: '',
    powerKw: '',
    color: '',
    ...overrides,
  };
}

describe('validatePendingVehicleForm — required fields', () => {
  it('accepts a valid body with no optional technical fields', () => {
    expect(validatePendingVehicleForm(values())).toEqual({});
  });

  it('flags every empty required field', () => {
    const errors = validatePendingVehicleForm(
      values({
        vin: '',
        plate: '',
        make: '',
        model: '',
        year: '',
        vehicleType: '',
        fuelType: '',
      }),
    );
    expect(Object.keys(errors).sort()).toEqual(
      ['fuelType', 'make', 'model', 'plate', 'vehicleType', 'vin', 'year'].sort(),
    );
  });
});

describe('validatePendingVehicleForm — optional technical fields', () => {
  it('accepts well-formed optional fields', () => {
    expect(
      validatePendingVehicleForm(
        values({
          version: '1.2 Easy',
          registrationDate: '2020-06-15',
          engineDisplacement: '1242',
          powerKw: '51',
          color: 'Bianco',
        }),
      ),
    ).toEqual({});
  });

  it('skips validation when an optional field is empty', () => {
    // Empty strings must never produce an error nor be treated as "0".
    expect(validatePendingVehicleForm(values()).engineDisplacement).toBeUndefined();
  });

  it('rejects a version longer than 150 chars', () => {
    expect(validatePendingVehicleForm(values({ version: 'x'.repeat(151) })).version).toBeDefined();
  });

  it('rejects a color longer than 50 chars', () => {
    expect(validatePendingVehicleForm(values({ color: 'x'.repeat(51) })).color).toBeDefined();
  });

  it('rejects a malformed registration date', () => {
    expect(
      validatePendingVehicleForm(values({ registrationDate: '15/06/2020' })).registrationDate,
    ).toBe('Data non valida');
  });

  it('rejects a future registration date', () => {
    expect(
      validatePendingVehicleForm(values({ registrationDate: '2999-01-01' })).registrationDate,
    ).toBe('La data non può essere futura');
  });

  it('rejects a non-positive or non-integer engine displacement', () => {
    expect(
      validatePendingVehicleForm(values({ engineDisplacement: '0' })).engineDisplacement,
    ).toBeDefined();
    expect(
      validatePendingVehicleForm(values({ engineDisplacement: '-5' })).engineDisplacement,
    ).toBeDefined();
    expect(
      validatePendingVehicleForm(values({ engineDisplacement: '1.5' })).engineDisplacement,
    ).toBeDefined();
  });

  it('rejects a non-positive power', () => {
    expect(validatePendingVehicleForm(values({ powerKw: '0' })).powerKw).toBeDefined();
  });
});
