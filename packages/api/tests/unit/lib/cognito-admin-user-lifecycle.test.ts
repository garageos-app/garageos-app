import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
} from '@aws-sdk/client-cognito-identity-provider';

import {
  createOfficineCognitoUser,
  setOfficineCognitoPassword,
  updateOfficineUserRoleAndLocation,
  _resetCognitoClientForTests,
} from '../../../src/lib/cognito.js';

const cognitoMock = mockClient(CognitoIdentityProviderClient);

describe('Cognito officine user lifecycle helpers', () => {
  beforeEach(() => {
    cognitoMock.reset();
    _resetCognitoClientForTests();
  });

  it('createOfficineCognitoUser issues AdminCreateUser with SUPPRESS + correct attrs', async () => {
    cognitoMock.on(AdminCreateUserCommand).resolves({
      User: { Attributes: [{ Name: 'sub', Value: 'sub-12345' }] },
    });
    const result = await createOfficineCognitoUser({
      poolId: 'pool-officine',
      email: 'mario@example.com',
      firstName: 'Mario',
      lastName: 'Rossi',
      tenantId: 'tenant-1',
      role: 'mechanic',
      locationId: 'loc-1',
    });
    expect(result.cognitoSub).toBe('sub-12345');
    const sentCommand = cognitoMock.commandCalls(AdminCreateUserCommand)[0]?.args[0];
    expect(sentCommand?.input.MessageAction).toBe('SUPPRESS');
    expect(sentCommand?.input.UserAttributes).toEqual(
      expect.arrayContaining([
        { Name: 'email', Value: 'mario@example.com' },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'given_name', Value: 'Mario' },
        { Name: 'family_name', Value: 'Rossi' },
        { Name: 'custom:tenant_id', Value: 'tenant-1' },
        { Name: 'custom:role', Value: 'mechanic' },
        { Name: 'custom:location_id', Value: 'loc-1' },
      ]),
    );
  });

  it('createOfficineCognitoUser omits custom:location_id when role=super_admin + null locationId', async () => {
    cognitoMock.on(AdminCreateUserCommand).resolves({
      User: { Attributes: [{ Name: 'sub', Value: 'sub-9' }] },
    });
    await createOfficineCognitoUser({
      poolId: 'pool-officine',
      email: 'admin@example.com',
      firstName: 'A',
      lastName: 'B',
      tenantId: 'tenant-1',
      role: 'super_admin',
      locationId: null,
    });
    const sentCommand = cognitoMock.commandCalls(AdminCreateUserCommand)[0]?.args[0];
    const attrs = sentCommand?.input.UserAttributes ?? [];
    expect(attrs.find((a) => a.Name === 'custom:location_id')).toBeUndefined();
  });

  it('setOfficineCognitoPassword uses AdminSetUserPassword with Permanent=true', async () => {
    cognitoMock.on(AdminSetUserPasswordCommand).resolves({});
    await setOfficineCognitoPassword({
      poolId: 'pool-officine',
      email: 'mario@example.com',
      password: 'Secret123!',
    });
    const sentCommand = cognitoMock.commandCalls(AdminSetUserPasswordCommand)[0]?.args[0];
    expect(sentCommand?.input.Permanent).toBe(true);
    expect(sentCommand?.input.Password).toBe('Secret123!');
  });

  it('updateOfficineUserRoleAndLocation issues AdminUpdateUserAttributes with both attrs when given', async () => {
    cognitoMock.on(AdminUpdateUserAttributesCommand).resolves({});
    await updateOfficineUserRoleAndLocation({
      poolId: 'pool-officine',
      email: 'mario@example.com',
      role: 'super_admin',
      locationId: null,
    });
    const sentCommand = cognitoMock.commandCalls(AdminUpdateUserAttributesCommand)[0]?.args[0];
    const attrs = sentCommand?.input.UserAttributes ?? [];
    expect(attrs).toEqual(
      expect.arrayContaining([
        { Name: 'custom:role', Value: 'super_admin' },
        { Name: 'custom:location_id', Value: '' },
      ]),
    );
  });

  it('updateOfficineUserRoleAndLocation skips role attr when role arg is undefined', async () => {
    cognitoMock.on(AdminUpdateUserAttributesCommand).resolves({});
    await updateOfficineUserRoleAndLocation({
      poolId: 'pool-officine',
      email: 'mario@example.com',
      locationId: 'loc-99',
    });
    const sentCommand = cognitoMock.commandCalls(AdminUpdateUserAttributesCommand)[0]?.args[0];
    const attrs = sentCommand?.input.UserAttributes ?? [];
    expect(attrs.find((a) => a.Name === 'custom:role')).toBeUndefined();
    expect(attrs.find((a) => a.Name === 'custom:location_id')?.Value).toBe('loc-99');
  });
});
