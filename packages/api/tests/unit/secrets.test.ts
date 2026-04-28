import { type SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadSecretsIntoEnv } from '../../src/config/secrets.js';

// Construct a SecretsManagerClient stand-in compatible with the SDK
// v3 `send(command)` shape. Keys we don't touch on the env are left
// undefined so we can `delete` them in beforeEach without affecting
// other env state.
function fakeClient(
  responder: () => { SecretString?: string } | Promise<{ SecretString?: string }>,
): { calls: number; client: SecretsManagerClient } {
  let calls = 0;
  const client = {
    send: async () => {
      calls += 1;
      return responder();
    },
  } as unknown as SecretsManagerClient;
  return {
    get calls() {
      return calls;
    },
    client,
  };
}

describe('loadSecretsIntoEnv', () => {
  const originalEnv = { ...process.env };
  const secretArn = 'arn:aws:secretsmanager:eu-central-1:123456789012:secret:test-AbCdEf';

  beforeEach(() => {
    delete process.env.APP_SECRETS_ARN;
    delete process.env.DATABASE_URL;
    delete process.env.SOMETHING_NEW;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('no-ops when APP_SECRETS_ARN is unset', async () => {
    const fake = fakeClient(() => ({ SecretString: '{}' }));
    await loadSecretsIntoEnv(fake.client);
    expect(fake.calls).toBe(0);
  });

  it('throws when SecretString is missing', async () => {
    process.env.APP_SECRETS_ARN = secretArn;
    const fake = fakeClient(() => ({}));
    await expect(loadSecretsIntoEnv(fake.client)).rejects.toThrow(/has no SecretString/);
  });

  it('populates process.env from each field of the secret JSON', async () => {
    process.env.APP_SECRETS_ARN = secretArn;
    const fake = fakeClient(() => ({
      SecretString: JSON.stringify({
        DATABASE_URL: 'postgres://from-sm/db',
        SOMETHING_NEW: 'value',
      }),
    }));
    await loadSecretsIntoEnv(fake.client);
    expect(process.env.DATABASE_URL).toBe('postgres://from-sm/db');
    expect(process.env.SOMETHING_NEW).toBe('value');
  });

  it('does not overwrite already-set env values', async () => {
    process.env.APP_SECRETS_ARN = secretArn;
    process.env.DATABASE_URL = 'postgres://local-override/db';
    const fake = fakeClient(() => ({
      SecretString: JSON.stringify({ DATABASE_URL: 'postgres://from-sm/db' }),
    }));
    await loadSecretsIntoEnv(fake.client);
    expect(process.env.DATABASE_URL).toBe('postgres://local-override/db');
  });
});
