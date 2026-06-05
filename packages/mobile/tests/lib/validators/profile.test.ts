import { validateProfileForm } from '@/lib/validators/profile';

const VALID = { firstName: 'Mario', lastName: 'Rossi', phone: '+393331112233' };

describe('validateProfileForm', () => {
  it('returns no errors for valid input', () => {
    expect(validateProfileForm(VALID)).toEqual({});
  });

  it('requires firstName', () => {
    expect(validateProfileForm({ ...VALID, firstName: '  ' }).firstName).toBeDefined();
  });

  it('requires lastName', () => {
    expect(validateProfileForm({ ...VALID, lastName: '' }).lastName).toBeDefined();
  });

  it('rejects firstName longer than 100 chars', () => {
    expect(validateProfileForm({ ...VALID, firstName: 'x'.repeat(101) }).firstName).toBeDefined();
  });

  it('accepts an empty phone (optional)', () => {
    expect(validateProfileForm({ ...VALID, phone: '' }).phone).toBeUndefined();
  });

  it('rejects an invalid phone', () => {
    expect(validateProfileForm({ ...VALID, phone: 'abc' }).phone).toBeDefined();
  });
});
