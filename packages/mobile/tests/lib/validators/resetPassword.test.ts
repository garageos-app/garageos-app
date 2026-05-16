import { validateResetPassword } from '@/lib/validators/resetPassword';

const VALID = {
  email: 'mario.rossi@example.com',
  code: '123456',
  password: 'newpassword1',
  confirmPassword: 'newpassword1',
};

describe('validateResetPassword', () => {
  it('returns no errors for valid input', () => {
    expect(validateResetPassword(VALID)).toEqual({});
  });

  it('flags empty code', () => {
    expect(validateResetPassword({ ...VALID, code: '' })).toEqual({ code: 'Codice obbligatorio' });
  });

  it('flags non-numeric code', () => {
    expect(validateResetPassword({ ...VALID, code: 'abc123' })).toEqual({
      code: 'Il codice deve essere di 6 cifre',
    });
  });

  it('flags code shorter than 6 digits', () => {
    expect(validateResetPassword({ ...VALID, code: '12345' })).toEqual({
      code: 'Il codice deve essere di 6 cifre',
    });
  });

  it('flags code longer than 6 digits', () => {
    expect(validateResetPassword({ ...VALID, code: '1234567' })).toEqual({
      code: 'Il codice deve essere di 6 cifre',
    });
  });

  it('flags empty password', () => {
    expect(validateResetPassword({ ...VALID, password: '', confirmPassword: '' })).toEqual({
      password: 'Password obbligatoria',
      confirmPassword: 'Conferma la password',
    });
  });

  it('flags password shorter than 8', () => {
    expect(validateResetPassword({ ...VALID, password: 'ab1', confirmPassword: 'ab1' })).toEqual({
      password: 'Almeno 8 caratteri',
    });
  });

  it('flags password without lowercase', () => {
    expect(
      validateResetPassword({ ...VALID, password: 'ABCDEFG1', confirmPassword: 'ABCDEFG1' }),
    ).toEqual({ password: 'Almeno una lettera minuscola' });
  });

  it('flags password without digit', () => {
    expect(
      validateResetPassword({ ...VALID, password: 'abcdefgh', confirmPassword: 'abcdefgh' }),
    ).toEqual({ password: 'Almeno un numero' });
  });

  it('flags mismatched confirmPassword', () => {
    expect(validateResetPassword({ ...VALID, confirmPassword: 'different1' })).toEqual({
      confirmPassword: 'Le password non coincidono',
    });
  });

  it('flags empty email', () => {
    expect(validateResetPassword({ ...VALID, email: '' })).toEqual({ email: 'Email obbligatoria' });
  });

  it('flags malformed email', () => {
    expect(validateResetPassword({ ...VALID, email: 'not-an-email' })).toEqual({
      email: 'Email non valida',
    });
  });
});
