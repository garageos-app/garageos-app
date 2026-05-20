import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { sendInvitationEmail, _resetSesClientForTests } from '../../../src/lib/ses-client.js';

const sesMock = mockClient(SESv2Client);

describe('sendInvitationEmail', () => {
  beforeEach(() => {
    sesMock.reset();
    _resetSesClientForTests();
    process.env.SES_FROM_ADDRESS = 'noreply@example.com';
    process.env.SES_CONFIGURATION_SET = 'test-config-set';
  });

  it('sends with FromEmailAddress + ToAddresses + ConfigurationSetName + HTML+text bodies', async () => {
    sesMock.on(SendEmailCommand).resolves({ MessageId: 'msg-1' });
    await sendInvitationEmail({
      toAddress: 'mario@example.com',
      invitedFirstName: 'Mario',
      invitedByName: 'Giuseppe',
      tenantName: 'Officina X',
      role: 'mechanic',
      magicLinkUrl: 'https://app.example.com/invitations/abc',
    });
    const call = sesMock.commandCalls(SendEmailCommand)[0]?.args[0];
    expect(call?.input.FromEmailAddress).toBe('noreply@example.com');
    expect(call?.input.Destination?.ToAddresses).toEqual(['mario@example.com']);
    expect(call?.input.ConfigurationSetName).toBe('test-config-set');
    expect(call?.input.Content?.Simple?.Subject?.Data).toMatch(/invito|invitation/i);
    expect(call?.input.Content?.Simple?.Body?.Html?.Data).toContain('Mario');
    expect(call?.input.Content?.Simple?.Body?.Text?.Data).toContain('Mario');
  });

  it('throws when env vars are missing', async () => {
    delete process.env.SES_FROM_ADDRESS;
    await expect(
      sendInvitationEmail({
        toAddress: 'mario@example.com',
        invitedFirstName: 'Mario',
        invitedByName: 'G',
        tenantName: 'X',
        role: 'mechanic',
        magicLinkUrl: 'https://x',
      }),
    ).rejects.toThrow(/SES env vars missing/);
  });
});
