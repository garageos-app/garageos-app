import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  InvalidPasswordException,
  UsernameExistsException,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _resetCognitoClientForTests,
  createCustomerCognitoUser,
  deleteCognitoUser,
  getCognitoClient,
  setCustomerCognitoPassword,
} from '../../../src/lib/cognito.js';

const cognitoMock = mockClient(CognitoIdentityProviderClient);

describe('lib/cognito — getCognitoClient', () => {
  afterEach(() => {
    _resetCognitoClientForTests();
  });

  it('returns a CognitoIdentityProviderClient instance', () => {
    const client = getCognitoClient();
    expect(client).toBeInstanceOf(CognitoIdentityProviderClient);
  });

  it('caches the client across calls (lazy singleton)', () => {
    const a = getCognitoClient();
    const b = getCognitoClient();
    expect(a).toBe(b);
  });

  it('rebuilds after _resetCognitoClientForTests', () => {
    const a = getCognitoClient();
    _resetCognitoClientForTests();
    const b = getCognitoClient();
    expect(a).not.toBe(b);
  });
});

describe('lib/cognito — createCustomerCognitoUser', () => {
  beforeEach(() => {
    cognitoMock.reset();
    _resetCognitoClientForTests();
  });

  it('returns the cognito sub from the User.Attributes array', async () => {
    cognitoMock.on(AdminCreateUserCommand).resolves({
      User: {
        Username: 'a@b.it',
        Attributes: [
          { Name: 'sub', Value: 'cognito-sub-uuid-123' },
          { Name: 'email', Value: 'a@b.it' },
          { Name: 'custom:customer_id', Value: 'customer-uuid-456' },
        ],
      },
    });

    const result = await createCustomerCognitoUser({
      poolId: 'eu-central-1_xxx',
      email: 'a@b.it',
      firstName: 'Mario',
      lastName: 'Rossi',
      customerId: 'customer-uuid-456',
    });
    expect(result.cognitoSub).toBe('cognito-sub-uuid-123');

    const call = cognitoMock.commandCalls(AdminCreateUserCommand)[0];
    expect(call?.args[0]?.input).toMatchObject({
      UserPoolId: 'eu-central-1_xxx',
      Username: 'a@b.it',
      MessageAction: 'SUPPRESS',
      UserAttributes: expect.arrayContaining([
        { Name: 'email', Value: 'a@b.it' },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'given_name', Value: 'Mario' },
        { Name: 'family_name', Value: 'Rossi' },
        { Name: 'custom:customer_id', Value: 'customer-uuid-456' },
      ]),
    });
  });

  it('throws CognitoEmailAlreadyExistsError on UsernameExistsException', async () => {
    cognitoMock
      .on(AdminCreateUserCommand)
      .rejects(new UsernameExistsException({ message: 'already', $metadata: {} }));
    await expect(
      createCustomerCognitoUser({
        poolId: 'p',
        email: 'a@b.it',
        firstName: 'M',
        lastName: 'R',
        customerId: 'c',
      }),
    ).rejects.toMatchObject({ name: 'CognitoEmailAlreadyExistsError' });
  });

  it('throws CognitoInvalidPasswordError on InvalidPasswordException', async () => {
    cognitoMock
      .on(AdminCreateUserCommand)
      .rejects(new InvalidPasswordException({ message: 'weak', $metadata: {} }));
    await expect(
      createCustomerCognitoUser({
        poolId: 'p',
        email: 'a@b.it',
        firstName: 'M',
        lastName: 'R',
        customerId: 'c',
      }),
    ).rejects.toMatchObject({ name: 'CognitoInvalidPasswordError' });
  });

  it('throws CognitoUnavailableError on generic AWS error', async () => {
    cognitoMock.on(AdminCreateUserCommand).rejects(new Error('throttled'));
    await expect(
      createCustomerCognitoUser({
        poolId: 'p',
        email: 'a@b.it',
        firstName: 'M',
        lastName: 'R',
        customerId: 'c',
      }),
    ).rejects.toMatchObject({ name: 'CognitoUnavailableError' });
  });

  it('throws CognitoUnavailableError when sub attribute is missing', async () => {
    cognitoMock.on(AdminCreateUserCommand).resolves({
      User: { Username: 'a@b.it', Attributes: [{ Name: 'email', Value: 'a@b.it' }] },
    });
    await expect(
      createCustomerCognitoUser({
        poolId: 'p',
        email: 'a@b.it',
        firstName: 'M',
        lastName: 'R',
        customerId: 'c',
      }),
    ).rejects.toMatchObject({ name: 'CognitoUnavailableError' });
  });
});

describe('lib/cognito — setCustomerCognitoPassword', () => {
  beforeEach(() => {
    cognitoMock.reset();
    _resetCognitoClientForTests();
  });

  it('calls AdminSetUserPassword with Permanent=true', async () => {
    cognitoMock.on(AdminSetUserPasswordCommand).resolves({});
    await setCustomerCognitoPassword({
      poolId: 'p',
      email: 'a@b.it',
      password: 'SuperSecret123',
    });
    const call = cognitoMock.commandCalls(AdminSetUserPasswordCommand)[0];
    expect(call?.args[0]?.input).toEqual({
      UserPoolId: 'p',
      Username: 'a@b.it',
      Password: 'SuperSecret123',
      Permanent: true,
    });
  });

  it('throws CognitoInvalidPasswordError on InvalidPasswordException', async () => {
    cognitoMock
      .on(AdminSetUserPasswordCommand)
      .rejects(new InvalidPasswordException({ message: 'weak', $metadata: {} }));
    await expect(
      setCustomerCognitoPassword({ poolId: 'p', email: 'a@b.it', password: 'x' }),
    ).rejects.toMatchObject({ name: 'CognitoInvalidPasswordError' });
  });

  it('throws CognitoUnavailableError on generic AWS error', async () => {
    cognitoMock.on(AdminSetUserPasswordCommand).rejects(new Error('boom'));
    await expect(
      setCustomerCognitoPassword({ poolId: 'p', email: 'a@b.it', password: 'x' }),
    ).rejects.toMatchObject({ name: 'CognitoUnavailableError' });
  });
});

describe('lib/cognito — deleteCognitoUser', () => {
  beforeEach(() => {
    cognitoMock.reset();
    _resetCognitoClientForTests();
  });

  it('calls AdminDeleteUser with the right input', async () => {
    cognitoMock.on(AdminDeleteUserCommand).resolves({});
    await deleteCognitoUser({ poolId: 'p', email: 'a@b.it' });
    const call = cognitoMock.commandCalls(AdminDeleteUserCommand)[0];
    expect(call?.args[0]?.input).toEqual({ UserPoolId: 'p', Username: 'a@b.it' });
  });

  it('swallows UserNotFoundException (idempotent)', async () => {
    cognitoMock
      .on(AdminDeleteUserCommand)
      .rejects(new UserNotFoundException({ message: 'not found', $metadata: {} }));
    await expect(deleteCognitoUser({ poolId: 'p', email: 'a@b.it' })).resolves.toBeUndefined();
  });

  it('rethrows generic AWS error as CognitoUnavailableError', async () => {
    cognitoMock.on(AdminDeleteUserCommand).rejects(new Error('boom'));
    await expect(deleteCognitoUser({ poolId: 'p', email: 'a@b.it' })).rejects.toMatchObject({
      name: 'CognitoUnavailableError',
    });
  });
});
