import {
  ALTRO_TYPE_KEY,
  validatePrivateInterventionForm,
} from '@/lib/validators/privateIntervention';

const VALID_CATALOG = {
  selectedKey: '11111111-1111-1111-1111-111111111111',
  customType: '',
  checklistItemIds: ['a'],
  interventionDate: '2020-05-10',
  odometerKm: '120000',
  description: 'Tagliando completo',
};

const VALID_ALTRO = {
  selectedKey: ALTRO_TYPE_KEY,
  customType: 'Lavaggio',
  checklistItemIds: [],
  interventionDate: '2020-05-10',
  odometerKm: '120000',
  description: 'Lavaggio completo interni ed esterni',
};

describe('validatePrivateInterventionForm', () => {
  it('accepts a valid catalog-type input', () => {
    expect(validatePrivateInterventionForm(VALID_CATALOG)).toEqual({});
  });

  it('accepts a valid Altro (free-text) input', () => {
    expect(validatePrivateInterventionForm(VALID_ALTRO)).toEqual({});
  });

  it('requires a type selection (selectedKey null)', () => {
    expect(
      validatePrivateInterventionForm({ ...VALID_CATALOG, selectedKey: null }).type,
    ).toBeDefined();
  });

  it('requires at least one checklist item for a catalog type (BR-300 parity)', () => {
    expect(
      validatePrivateInterventionForm({ ...VALID_CATALOG, checklistItemIds: [] }).checklistItemIds,
    ).toBeDefined();
  });

  it('does not require checklist items on the Altro path', () => {
    expect(
      validatePrivateInterventionForm({ ...VALID_ALTRO, checklistItemIds: [] }).checklistItemIds,
    ).toBeUndefined();
  });

  it('requires customType on the Altro path', () => {
    expect(
      validatePrivateInterventionForm({ ...VALID_ALTRO, customType: '  ' }).customType,
    ).toBeDefined();
  });

  it('rejects customType longer than 150 chars on the Altro path', () => {
    expect(
      validatePrivateInterventionForm({ ...VALID_ALTRO, customType: 'x'.repeat(151) }).customType,
    ).toBeDefined();
  });

  it('does not require customType on the catalog path', () => {
    expect(
      validatePrivateInterventionForm({ ...VALID_CATALOG, customType: '' }).customType,
    ).toBeUndefined();
  });

  it('requires description', () => {
    expect(
      validatePrivateInterventionForm({ ...VALID_CATALOG, description: '' }).description,
    ).toBeDefined();
  });

  it('rejects description longer than 5000 chars', () => {
    expect(
      validatePrivateInterventionForm({ ...VALID_CATALOG, description: 'x'.repeat(5001) })
        .description,
    ).toBeDefined();
  });

  it('rejects a malformed date', () => {
    expect(
      validatePrivateInterventionForm({ ...VALID_CATALOG, interventionDate: '10/05/2020' })
        .interventionDate,
    ).toBeDefined();
  });

  it('rejects an impossible date', () => {
    expect(
      validatePrivateInterventionForm({ ...VALID_CATALOG, interventionDate: '2026-02-30' })
        .interventionDate,
    ).toBeDefined();
  });

  it('rejects a future date', () => {
    expect(
      validatePrivateInterventionForm({ ...VALID_CATALOG, interventionDate: '2099-01-01' })
        .interventionDate,
    ).toBeDefined();
  });

  it('accepts an empty odometer (optional)', () => {
    expect(
      validatePrivateInterventionForm({ ...VALID_CATALOG, odometerKm: '' }).odometerKm,
    ).toBeUndefined();
  });

  it('rejects a non-numeric odometer', () => {
    expect(
      validatePrivateInterventionForm({ ...VALID_CATALOG, odometerKm: '12a' }).odometerKm,
    ).toBeDefined();
  });

  it('rejects an out-of-range odometer', () => {
    expect(
      validatePrivateInterventionForm({ ...VALID_CATALOG, odometerKm: '10000000' }).odometerKm,
    ).toBeDefined();
  });
});
