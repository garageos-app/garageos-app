import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { mockClient } from 'aws-sdk-client-mock';

import { _resetSesClientForTests, sendVerificationEmail } from '../../../src/lib/ses-client.js';

const sesMock = mockClient(SESv2Client);

describe('sendVerificationEmail', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    sesMock.reset();
    _resetSesClientForTests();
    process.env.SES_FROM_ADDRESS = 'noreply@garageos.test';
    process.env.SES_CONFIGURATION_SET = 'test-config-set';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('issues SendEmailCommand with FromEmailAddress, Destination, ConfigurationSetName', async () => {
    sesMock.on(SendEmailCommand).resolves({ MessageId: 'msg-1' });
    await sendVerificationEmail({
      toAddress: 'user@example.com',
      customerName: 'Mario',
      verificationUrl: 'https://app.example.com/verify-email?token=abc',
    });
    const calls = sesMock.commandCalls(SendEmailCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0]!.input as {
      FromEmailAddress?: string;
      Destination?: { ToAddresses?: string[] };
      ConfigurationSetName?: string;
      Content?: { Simple?: { Subject?: { Data?: string } } };
    };
    expect(input.FromEmailAddress).toBe('noreply@garageos.test');
    expect(input.Destination?.ToAddresses).toEqual(['user@example.com']);
    expect(input.ConfigurationSetName).toBe('test-config-set');
    expect(input.Content?.Simple?.Subject?.Data).toMatch(/[Vv]erifica/);
  });

  it('throws when SES_FROM_ADDRESS env var is missing', async () => {
    delete process.env.SES_FROM_ADDRESS;
    await expect(
      sendVerificationEmail({
        toAddress: 'user@example.com',
        customerName: 'Mario',
        verificationUrl: 'https://app.example.com/verify-email?token=abc',
      }),
    ).rejects.toThrow(/SES env vars missing/);
  });

  it('throws when SES_CONFIGURATION_SET env var is missing', async () => {
    delete process.env.SES_CONFIGURATION_SET;
    await expect(
      sendVerificationEmail({
        toAddress: 'user@example.com',
        customerName: 'Mario',
        verificationUrl: 'https://app.example.com/verify-email?token=abc',
      }),
    ).rejects.toThrow(/SES env vars missing/);
  });
});
