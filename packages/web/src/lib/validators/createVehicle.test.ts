import { describe, expect, it } from 'vitest';

import {
  CreateVehiclePayloadSchema,
  VehicleFormSchema,
  transformToPayload,
  type VehicleFormValues,
} from './createVehicle';

const base: VehicleFormValues = {
  customerMode: 'create_new',
  customerId: '',
  firstName: 'Mario',
  lastName: 'Rossi',
  email: 'mario@example.it',
  phone: '',
  taxCode: '',
  isBusiness: false,
  businessName: '',
  vatNumber: '',
  vin: '1hgcm82633a004352',
  plate: 'ab123cd',
  plateCountry: 'it',
  make: 'Fiat',
  model: 'Panda',
  version: '',
  year: '2020',
  registrationDate: '',
  vehicleType: 'car',
  fuelType: 'petrol',
  engineDisplacement: '',
  powerKw: '',
  color: '',
  odometerKm: '45000',
};

describe('transformToPayload', () => {
  it('produces a payload accepted by CreateVehiclePayloadSchema and uppercases vin/plate/country', () => {
    const payload = transformToPayload(base);
    expect(payload.vehicle.vin).toBe('1HGCM82633A004352');
    expect(payload.vehicle.plate).toBe('AB123CD');
    expect(payload.vehicle.plateCountry).toBe('IT');
    expect(payload.vehicle.year).toBe(2020);
    expect(payload.vehicle.odometerKm).toBe(45000);
    expect(payload.sendInvitationEmail).toBe(false);
    expect(payload.forceNonstandardVin).toBe(false);
    expect(CreateVehiclePayloadSchema.safeParse(payload).success).toBe(true);
  });

  it('drops empty optional fields instead of sending empty strings', () => {
    const payload = transformToPayload(base);
    expect('version' in payload.vehicle).toBe(false);
    expect('color' in payload.vehicle).toBe(false);
    expect('engineDisplacement' in payload.vehicle).toBe(false);
    expect('powerKw' in payload.vehicle).toBe(false);
    expect('registrationDate' in payload.vehicle).toBe(false);
  });

  it('converts present optional numbers and keeps provided optionals', () => {
    const payload = transformToPayload({
      ...base,
      version: '1.2 Easy',
      engineDisplacement: '1242',
      powerKw: '51',
      color: 'Rosso',
      registrationDate: '2020-03-15',
    });
    expect(payload.vehicle.engineDisplacement).toBe(1242);
    expect(payload.vehicle.powerKw).toBe(51);
    expect(payload.vehicle.version).toBe('1.2 Easy');
    expect(payload.vehicle.registrationDate).toBe('2020-03-15');
  });

  it('emits an existing-customer discriminator when mode=existing', () => {
    const payload = transformToPayload({
      ...base,
      customerMode: 'existing',
      customerId: '22222222-2222-4222-8222-222222222222',
    });
    expect(payload.customer).toEqual({
      mode: 'existing',
      customerId: '22222222-2222-4222-8222-222222222222',
    });
  });

  it('includes businessName/vatNumber only for business customers', () => {
    const consumer = transformToPayload(base);
    expect('businessName' in consumer.customer).toBe(false);

    const business = transformToPayload({
      ...base,
      isBusiness: true,
      businessName: 'Rossi SRL',
      vatNumber: 'IT01234567890',
    });
    expect(business.customer).toMatchObject({
      mode: 'create_new',
      isBusiness: true,
      businessName: 'Rossi SRL',
      vatNumber: 'IT01234567890',
    });
  });
});

describe('VehicleFormSchema', () => {
  it('accepts a fully valid create_new form', () => {
    const result = VehicleFormSchema.safeParse(base);
    expect(result.success).toBe(true);
  });

  it('rejects existing mode with empty customerId', () => {
    const result = VehicleFormSchema.safeParse({
      ...base,
      customerMode: 'existing',
      customerId: '',
    });
    expect(result.success).toBe(false);
    expect(result.error!.issues.some((i) => i.path[0] === 'customerId')).toBe(true);
  });

  it('rejects create_new with a malformed email', () => {
    const result = VehicleFormSchema.safeParse({ ...base, email: 'nope' });
    expect(result.success).toBe(false);
    const emailIssue = result.error!.issues.find((i) => i.path[0] === 'email');
    expect(emailIssue).toBeDefined();
    expect(emailIssue!.message).toBe('Email non valida');
  });

  it('rejects create_new business with missing businessName', () => {
    const result = VehicleFormSchema.safeParse({
      ...base,
      isBusiness: true,
      businessName: '',
      vatNumber: 'IT01234567890',
    });
    expect(result.success).toBe(false);
    expect(result.error!.issues.some((i) => i.path[0] === 'businessName')).toBe(true);
  });

  it('accepts existing mode with empty firstName/lastName/email', () => {
    const result = VehicleFormSchema.safeParse({
      ...base,
      customerMode: 'existing',
      customerId: '22222222-2222-4222-8222-222222222222',
      firstName: '',
      lastName: '',
      email: '',
    });
    expect(result.success).toBe(true);
  });
});
