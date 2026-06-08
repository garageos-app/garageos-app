import { validateDisputeForm } from '@/lib/validators/dispute';

describe('validateDisputeForm', () => {
  it('passes with a category and a 20..2000 char description', () => {
    const errors = validateDisputeForm({
      reasonCategory: 'wrong_data',
      description: 'I dati riportati su questo intervento sono errati.',
    });
    expect(errors).toEqual({});
  });

  it('requires a category', () => {
    const errors = validateDisputeForm({
      reasonCategory: null,
      description: 'I dati riportati su questo intervento sono errati.',
    });
    expect(errors.reasonCategory).toBeTruthy();
  });

  it('rejects a description shorter than 20 chars', () => {
    const errors = validateDisputeForm({ reasonCategory: 'other', description: 'troppo corta' });
    expect(errors.description).toBeTruthy();
  });

  it('rejects a description longer than 2000 chars', () => {
    const errors = validateDisputeForm({
      reasonCategory: 'other',
      description: 'a'.repeat(2001),
    });
    expect(errors.description).toBeTruthy();
  });
});
