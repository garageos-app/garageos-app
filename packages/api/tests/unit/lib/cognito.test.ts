import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { afterEach, describe, expect, it } from 'vitest';

import { _resetCognitoClientForTests, getCognitoClient } from '../../../src/lib/cognito.js';

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
