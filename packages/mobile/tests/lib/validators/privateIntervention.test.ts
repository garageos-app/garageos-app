import { validatePrivateInterventionForm } from '@/lib/validators/privateIntervention';

const VALID = {
  customType: 'Lavaggio',
  interventionDate: '2020-05-10',
  odometerKm: '120000',
  description: 'Lavaggio completo interni ed esterni',
};

describe('validatePrivateInterventionForm', () => {
  it('returns no errors for a valid input', () => {
    expect(validatePrivateInterventionForm(VALID)).toEqual({});
  });

  it('requires customType', () => {
    expect(
      validatePrivateInterventionForm({ ...VALID, customType: '  ' }).customType,
    ).toBeDefined();
  });

  it('rejects customType longer than 150 chars', () => {
    expect(
      validatePrivateInterventionForm({ ...VALID, customType: 'x'.repeat(151) }).customType,
    ).toBeDefined();
  });

  it('requires description', () => {
    expect(
      validatePrivateInterventionForm({ ...VALID, description: '' }).description,
    ).toBeDefined();
  });

  it('rejects description longer than 5000 chars', () => {
    expect(
      validatePrivateInterventionForm({ ...VALID, description: 'x'.repeat(5001) }).description,
    ).toBeDefined();
  });

  it('rejects a malformed date', () => {
    expect(
      validatePrivateInterventionForm({ ...VALID, interventionDate: '10/05/2020' })
        .interventionDate,
    ).toBeDefined();
  });

  it('rejects an impossible date', () => {
    expect(
      validatePrivateInterventionForm({ ...VALID, interventionDate: '2026-02-30' })
        .interventionDate,
    ).toBeDefined();
  });

  it('rejects a future date', () => {
    expect(
      validatePrivateInterventionForm({ ...VALID, interventionDate: '2099-01-01' })
        .interventionDate,
    ).toBeDefined();
  });

  it('accepts an empty odometer (optional)', () => {
    expect(
      validatePrivateInterventionForm({ ...VALID, odometerKm: '' }).odometerKm,
    ).toBeUndefined();
  });

  it('rejects a non-numeric odometer', () => {
    expect(
      validatePrivateInterventionForm({ ...VALID, odometerKm: '12a' }).odometerKm,
    ).toBeDefined();
  });

  it('rejects an out-of-range odometer', () => {
    expect(
      validatePrivateInterventionForm({ ...VALID, odometerKm: '10000000' }).odometerKm,
    ).toBeDefined();
  });
});
