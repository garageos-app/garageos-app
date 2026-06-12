import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { mockClient } from 'aws-sdk-client-mock';

import { sendEmail } from '../../../../src/lib/notifications/email-channel.js';
import { _resetSesClientForTests } from '../../../../src/lib/ses-client.js';

// Pre-flight per feedback_aws_sdk_presigner_credentials_chain.md:
// SES SDK invokes the credential provider chain even with mockClient.
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';

const sesMock = mockClient(SESv2Client);

describe('sendEmail (notifications channel)', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    sesMock.reset();
    _resetSesClientForTests();
    process.env.SES_FROM_ADDRESS = 'noreply@garageos.test';
    process.env.SES_CONFIGURATION_SET = 'test-config-set';
    // Isolate from ambient env: these tests assert the SES default path.
    delete process.env.EMAIL_PROVIDER;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('issues SendEmailCommand with FromEmailAddress, Destination, ConfigurationSet', async () => {
    sesMock.on(SendEmailCommand).resolves({ MessageId: 'msg-1' });
    await sendEmail({
      toAddress: 'mario@test.it',
      subject: 'Test',
      html: '<p>html</p>',
      text: 'text',
    });
    const calls = sesMock.commandCalls(SendEmailCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0]!.input as {
      FromEmailAddress?: string;
      Destination?: { ToAddresses?: string[] };
      ConfigurationSetName?: string;
      Content?: {
        Simple?: {
          Subject?: { Data?: string };
          Body?: { Html?: { Data?: string }; Text?: { Data?: string } };
        };
      };
    };
    expect(input.FromEmailAddress).toBe('noreply@garageos.test');
    expect(input.Destination?.ToAddresses).toEqual(['mario@test.it']);
    expect(input.ConfigurationSetName).toBe('test-config-set');
    expect(input.Content?.Simple?.Subject?.Data).toBe('Test');
    expect(input.Content?.Simple?.Body?.Html?.Data).toBe('<p>html</p>');
    expect(input.Content?.Simple?.Body?.Text?.Data).toBe('text');
  });

  it('throws when SES_FROM_ADDRESS missing', async () => {
    delete process.env.SES_FROM_ADDRESS;
    await expect(
      sendEmail({ toAddress: 'm@t.it', subject: 's', html: 'h', text: 't' }),
    ).rejects.toThrow(/SES env vars missing/);
  });

  it('throws when SES_CONFIGURATION_SET missing', async () => {
    delete process.env.SES_CONFIGURATION_SET;
    await expect(
      sendEmail({ toAddress: 'm@t.it', subject: 's', html: 'h', text: 't' }),
    ).rejects.toThrow(/SES env vars missing/);
  });

  it('propagates SES errors (caller handles them)', async () => {
    sesMock.on(SendEmailCommand).rejects(new Error('Throttling'));
    await expect(
      sendEmail({ toAddress: 'm@t.it', subject: 's', html: 'h', text: 't' }),
    ).rejects.toThrow(/Throttling/);
  });
});
