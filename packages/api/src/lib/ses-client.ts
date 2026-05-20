import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

import { renderVerifyEmailHtml, renderVerifyEmailText } from './email/verify-email-template.js';
import { renderInviteUserHtml, renderInviteUserText } from './email/invite-user-template.js';
import type { UserRole } from '../middleware/tenant-context.js';

// Lazy singleton — see lib/cognito.ts for the same pattern. Tests use
// `_resetSesClientForTests` to ensure aws-sdk-client-mock overrides
// the underlying transport on every test setup.
let _client: SESv2Client | null = null;

export function getSesClient(): SESv2Client {
  if (_client) return _client;
  _client = new SESv2Client({});
  return _client;
}

// Test-only reset hook. Production code never imports this.
export function _resetSesClientForTests(): void {
  _client = null;
}

export interface SendVerificationEmailInput {
  toAddress: string;
  customerName: string;
  verificationUrl: string;
}

export async function sendVerificationEmail(input: SendVerificationEmailInput): Promise<void> {
  const fromAddress = process.env.SES_FROM_ADDRESS;
  const configurationSet = process.env.SES_CONFIGURATION_SET;
  if (!fromAddress || !configurationSet) {
    throw new Error('SES env vars missing');
  }
  const subject = 'Verifica il tuo indirizzo email — GarageOS';
  const html = renderVerifyEmailHtml(input.customerName, input.verificationUrl);
  const text = renderVerifyEmailText(input.customerName, input.verificationUrl);
  await getSesClient().send(
    new SendEmailCommand({
      FromEmailAddress: fromAddress,
      Destination: { ToAddresses: [input.toAddress] },
      ConfigurationSetName: configurationSet,
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: {
            Html: { Data: html, Charset: 'UTF-8' },
            Text: { Data: text, Charset: 'UTF-8' },
          },
        },
      },
    }),
  );
}

export interface SendInvitationEmailInput {
  toAddress: string;
  invitedFirstName: string;
  invitedByName: string;
  tenantName: string;
  role: UserRole;
  magicLinkUrl: string;
}

export async function sendInvitationEmail(input: SendInvitationEmailInput): Promise<void> {
  const fromAddress = process.env.SES_FROM_ADDRESS;
  const configurationSet = process.env.SES_CONFIGURATION_SET;
  if (!fromAddress || !configurationSet) {
    throw new Error('SES env vars missing');
  }
  const subject = `Invito a ${input.tenantName} su GarageOS`;
  const html = renderInviteUserHtml(input);
  const text = renderInviteUserText(input);
  await getSesClient().send(
    new SendEmailCommand({
      FromEmailAddress: fromAddress,
      Destination: { ToAddresses: [input.toAddress] },
      ConfigurationSetName: configurationSet,
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: {
            Html: { Data: html, Charset: 'UTF-8' },
            Text: { Data: text, Charset: 'UTF-8' },
          },
        },
      },
    }),
  );
}
