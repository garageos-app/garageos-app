import { validateForgotPassword } from '@/lib/validators/forgotPassword';

describe('validateForgotPassword', () => {
  it('flags empty email', () => {
    expect(validateForgotPassword({ email: '' })).toEqual({ email: 'Email obbligatoria' });
  });

  it('flags malformed email', () => {
    expect(validateForgotPassword({ email: 'not-an-email' })).toEqual({
      email: 'Email non valida',
    });
  });

  it('accepts a valid email', () => {
    expect(validateForgotPassword({ email: 'mario.rossi@example.com' })).toEqual({});
  });
});
