import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { mockClient } from 'aws-sdk-client-mock';

import { deliverEmail, _resetSesClientForTests } from '../../../../src/lib/email/transport.js';

// Pre-flight per feedback_aws_sdk_presigner_credentials_chain.md:
// SES SDK invokes the credential provider chain even with mockClient.
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';

const sesMock = mockClient(SESv2Client);

const MESSAGE = {
  toAddress: 'mario@test.it',
  subject: 'Oggetto',
  html: '<p>html</p>',
  text: 'testo',
};

describe('deliverEmail', () => {
  const ORIGINAL_ENV = { ...process.env };
  const fetchMock = vi.fn();

  beforeEach(() => {
    sesMock.reset();
    _resetSesClientForTests();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    process.env.SES_FROM_ADDRESS = 'noreply@garageos.test';
    process.env.SES_CONFIGURATION_SET = 'test-config-set';
    delete process.env.EMAIL_PROVIDER;
    delete process.env.RESEND_API_KEY;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...ORIGINAL_ENV };
  });

  describe('SES path', () => {
    it('defaults to SES when EMAIL_PROVIDER is unset', async () => {
      sesMock.on(SendEmailCommand).resolves({ MessageId: 'msg-1' });
      await deliverEmail(MESSAGE);
      expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(1);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('sends via SES with from, destination, config set and content', async () => {
      process.env.EMAIL_PROVIDER = 'ses';
      sesMock.on(SendEmailCommand).resolves({ MessageId: 'msg-1' });
      await deliverEmail(MESSAGE);
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
      expect(input.Content?.Simple?.Subject?.Data).toBe('Oggetto');
      expect(input.Content?.Simple?.Body?.Html?.Data).toBe('<p>html</p>');
      expect(input.Content?.Simple?.Body?.Text?.Data).toBe('testo');
    });

    it('throws when SES_FROM_ADDRESS missing', async () => {
      delete process.env.SES_FROM_ADDRESS;
      await expect(deliverEmail(MESSAGE)).rejects.toThrow(/SES env vars missing/);
    });

    it('throws when SES_CONFIGURATION_SET missing', async () => {
      delete process.env.SES_CONFIGURATION_SET;
      await expect(deliverEmail(MESSAGE)).rejects.toThrow(/SES env vars missing/);
    });

    it('propagates SES errors (caller handles them)', async () => {
      sesMock.on(SendEmailCommand).rejects(new Error('Throttling'));
      await expect(deliverEmail(MESSAGE)).rejects.toThrow(/Throttling/);
    });
  });

  describe('Resend path', () => {
    beforeEach(() => {
      process.env.EMAIL_PROVIDER = 'resend';
      process.env.RESEND_API_KEY = 're_test_key';
    });

    it('POSTs to the Resend API with bearer auth and the message payload', async () => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: 'email-1' }), { status: 200 }));
      await deliverEmail(MESSAGE);
      expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
      expect(url).toBe('https://api.resend.com/emails');
      expect(init.method).toBe('POST');
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.headers).toMatchObject({
        Authorization: 'Bearer re_test_key',
        'Content-Type': 'application/json',
      });
      expect(JSON.parse(init.body as string)).toEqual({
        from: 'noreply@garageos.test',
        to: ['mario@test.it'],
        subject: 'Oggetto',
        html: '<p>html</p>',
        text: 'testo',
      });
    });

    it('throws when RESEND_API_KEY missing', async () => {
      delete process.env.RESEND_API_KEY;
      await expect(deliverEmail(MESSAGE)).rejects.toThrow(/Resend env vars missing/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('throws when SES_FROM_ADDRESS missing', async () => {
      delete process.env.SES_FROM_ADDRESS;
      await expect(deliverEmail(MESSAGE)).rejects.toThrow(/Resend env vars missing/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not require SES_CONFIGURATION_SET', async () => {
      delete process.env.SES_CONFIGURATION_SET;
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: 'email-1' }), { status: 200 }));
      await expect(deliverEmail(MESSAGE)).resolves.toBeUndefined();
    });

    it('throws on non-2xx response including status and body', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ statusCode: 422, message: 'Invalid `to` field' }), {
          status: 422,
        }),
      );
      await expect(deliverEmail(MESSAGE)).rejects.toThrow(/Resend send failed: 422.*Invalid/);
    });

    it('propagates network errors (caller handles them)', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNRESET'));
      await expect(deliverEmail(MESSAGE)).rejects.toThrow(/ECONNRESET/);
    });
  });

  it('throws on unknown EMAIL_PROVIDER values', async () => {
    process.env.EMAIL_PROVIDER = 'sendgrid';
    await expect(deliverEmail(MESSAGE)).rejects.toThrow(/Unknown EMAIL_PROVIDER/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
  });
});
