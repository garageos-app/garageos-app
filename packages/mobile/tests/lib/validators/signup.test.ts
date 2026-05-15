import { validateSignupForm } from '@/lib/validators/signup';

describe('validateSignupForm', () => {
  const valid = {
    email: 'mario.rossi@example.com',
    password: 'miapassword1',
    confirmPassword: 'miapassword1',
    firstName: 'Mario',
    lastName: 'Rossi',
  };

  it('returns empty errors for fully valid input', () => {
    expect(validateSignupForm(valid)).toEqual({});
  });

  it('flags missing email', () => {
    expect(validateSignupForm({ ...valid, email: '' })).toMatchObject({
      email: 'Email obbligatoria',
    });
  });

  it('flags malformed email', () => {
    expect(validateSignupForm({ ...valid, email: 'not-an-email' })).toMatchObject({
      email: 'Email non valida',
    });
  });

  it('flags password shorter than 8 chars', () => {
    expect(
      validateSignupForm({ ...valid, password: 'short1', confirmPassword: 'short1' }),
    ).toMatchObject({ password: 'Almeno 8 caratteri' });
  });

  it('flags password without lowercase', () => {
    expect(
      validateSignupForm({ ...valid, password: 'PASSWORD1', confirmPassword: 'PASSWORD1' }),
    ).toMatchObject({ password: 'Almeno una lettera minuscola' });
  });

  it('flags password without digit', () => {
    expect(
      validateSignupForm({ ...valid, password: 'password', confirmPassword: 'password' }),
    ).toMatchObject({ password: 'Almeno un numero' });
  });

  it('flags confirm password mismatch', () => {
    expect(validateSignupForm({ ...valid, confirmPassword: 'different1' })).toMatchObject({
      confirmPassword: 'Le password non coincidono',
    });
  });

  it('flags empty firstName and lastName', () => {
    expect(validateSignupForm({ ...valid, firstName: '', lastName: '   ' })).toMatchObject({
      firstName: 'Nome obbligatorio',
      lastName: 'Cognome obbligatorio',
    });
  });
});
