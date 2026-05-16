// Mocks amazon-cognito-identity-js at the module level so we can verify
// CognitoUser.forgotPassword + confirmPassword are wired to the right
// callbacks and that the wrapper resolves the discriminated union shape.
//
// Note: variables referenced inside jest.mock() factories must be prefixed
// with 'mock' (case-insensitive) to satisfy babel-jest hoisting rules.

const mockForgotPassword = jest.fn();
const mockConfirmPassword = jest.fn();

jest.mock('amazon-cognito-identity-js', () => ({
  __esModule: true,
  CognitoUserPool: jest.fn().mockImplementation(() => ({})),
  CognitoUser: jest.fn().mockImplementation(() => ({
    forgotPassword: mockForgotPassword,
    confirmPassword: mockConfirmPassword,
  })),
  // Stubs not exercised by these tests but required so cognito.ts imports
  // type-check against the mocked module.
  AuthenticationDetails: jest.fn(),
}));

import { forgotPasswordRequest, confirmForgotPassword } from '@/lib/cognito';

describe('forgotPasswordRequest', () => {
  beforeEach(() => {
    mockForgotPassword.mockReset();
  });

  it('resolves ok:true with deliveryMedium on success', async () => {
    mockForgotPassword.mockImplementation((callbacks: { onSuccess: (data: unknown) => void }) => {
      callbacks.onSuccess({ CodeDeliveryDetails: { DeliveryMedium: 'EMAIL' } });
    });
    await expect(forgotPasswordRequest('u@example.com')).resolves.toEqual({
      ok: true,
      deliveryMedium: 'EMAIL',
    });
  });

  it('resolves ok:true UNKNOWN delivery when payload missing', async () => {
    mockForgotPassword.mockImplementation((callbacks: { onSuccess: (data: unknown) => void }) => {
      callbacks.onSuccess({});
    });
    await expect(forgotPasswordRequest('u@example.com')).resolves.toEqual({
      ok: true,
      deliveryMedium: 'UNKNOWN',
    });
  });

  it('resolves ok:true with deliveryMedium SMS when SDK reports SMS', async () => {
    mockForgotPassword.mockImplementation((callbacks: { onSuccess: (data: unknown) => void }) => {
      callbacks.onSuccess({ CodeDeliveryDetails: { DeliveryMedium: 'SMS' } });
    });
    await expect(forgotPasswordRequest('u@example.com')).resolves.toEqual({
      ok: true,
      deliveryMedium: 'SMS',
    });
  });

  it('silences UserNotFoundException and resolves ok:true (anti-enumeration)', async () => {
    mockForgotPassword.mockImplementation(
      (callbacks: { onFailure: (err: { code?: string; name?: string }) => void }) => {
        callbacks.onFailure({ code: 'UserNotFoundException', name: 'UserNotFoundException' });
      },
    );
    await expect(forgotPasswordRequest('nobody@example.com')).resolves.toEqual({
      ok: true,
      deliveryMedium: 'UNKNOWN',
    });
  });

  it('resolves ok:false on LimitExceededException', async () => {
    mockForgotPassword.mockImplementation(
      (callbacks: { onFailure: (err: { code?: string; name?: string }) => void }) => {
        callbacks.onFailure({ code: 'LimitExceededException', name: 'LimitExceededException' });
      },
    );
    await expect(forgotPasswordRequest('u@example.com')).resolves.toEqual({
      ok: false,
      code: 'LimitExceededException',
    });
  });

  it('falls back to err.name when code is missing', async () => {
    mockForgotPassword.mockImplementation(
      (callbacks: { onFailure: (err: { name?: string }) => void }) => {
        callbacks.onFailure({ name: 'NotAuthorizedException' });
      },
    );
    await expect(forgotPasswordRequest('u@example.com')).resolves.toEqual({
      ok: false,
      code: 'NotAuthorizedException',
    });
  });
});

describe('confirmForgotPassword', () => {
  beforeEach(() => {
    mockConfirmPassword.mockReset();
  });

  it('resolves ok:true on success', async () => {
    mockConfirmPassword.mockImplementation(
      (_code: string, _pwd: string, callbacks: { onSuccess: () => void }) => {
        callbacks.onSuccess();
      },
    );
    await expect(confirmForgotPassword('u@example.com', '123456', 'newpassword1')).resolves.toEqual(
      { ok: true },
    );
  });

  it('forwards code+password to the SDK', async () => {
    mockConfirmPassword.mockImplementation(
      (_code: string, _pwd: string, callbacks: { onSuccess: () => void }) => {
        callbacks.onSuccess();
      },
    );
    await confirmForgotPassword('u@example.com', '654321', 'newpassword2');
    expect(mockConfirmPassword).toHaveBeenCalledWith('654321', 'newpassword2', expect.any(Object));
  });

  it('resolves ok:false on CodeMismatchException', async () => {
    mockConfirmPassword.mockImplementation(
      (
        _code: string,
        _pwd: string,
        callbacks: { onFailure: (err: { code?: string; name?: string }) => void },
      ) => {
        callbacks.onFailure({ code: 'CodeMismatchException', name: 'CodeMismatchException' });
      },
    );
    await expect(confirmForgotPassword('u@example.com', 'bad000', 'newpassword1')).resolves.toEqual(
      { ok: false, code: 'CodeMismatchException' },
    );
  });

  it('resolves ok:false on ExpiredCodeException', async () => {
    mockConfirmPassword.mockImplementation(
      (
        _code: string,
        _pwd: string,
        callbacks: { onFailure: (err: { code?: string; name?: string }) => void },
      ) => {
        callbacks.onFailure({ code: 'ExpiredCodeException', name: 'ExpiredCodeException' });
      },
    );
    await expect(confirmForgotPassword('u@example.com', '000000', 'newpassword1')).resolves.toEqual(
      { ok: false, code: 'ExpiredCodeException' },
    );
  });

  it('resolves ok:false on InvalidPasswordException', async () => {
    mockConfirmPassword.mockImplementation(
      (
        _code: string,
        _pwd: string,
        callbacks: { onFailure: (err: { code?: string; name?: string }) => void },
      ) => {
        callbacks.onFailure({
          code: 'InvalidPasswordException',
          name: 'InvalidPasswordException',
        });
      },
    );
    await expect(confirmForgotPassword('u@example.com', '123456', 'short')).resolves.toEqual({
      ok: false,
      code: 'InvalidPasswordException',
    });
  });
});
