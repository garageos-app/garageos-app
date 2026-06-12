import { renderVerifyEmailHtml, renderVerifyEmailText } from './email/verify-email-template.js';
import { renderInviteUserHtml, renderInviteUserText } from './email/invite-user-template.js';
import { deliverEmail } from './email/transport.js';
import type { UserRole } from '../middleware/tenant-context.js';

// Template-level senders for transactional auth/onboarding emails.
// Transport (SES vs Resend) is selected inside lib/email/transport.ts —
// this module only renders templates and hands the message over.
// getSesClient/_resetSesClientForTests are re-exported for the existing
// test suites that reset the SES singleton between cases.
export { getSesClient, _resetSesClientForTests } from './email/transport.js';

export interface SendVerificationEmailInput {
  toAddress: string;
  customerName: string;
  verificationUrl: string;
}

export async function sendVerificationEmail(input: SendVerificationEmailInput): Promise<void> {
  await deliverEmail({
    toAddress: input.toAddress,
    subject: 'Verifica il tuo indirizzo email — GarageOS',
    html: renderVerifyEmailHtml(input.customerName, input.verificationUrl),
    text: renderVerifyEmailText(input.customerName, input.verificationUrl),
  });
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
  await deliverEmail({
    toAddress: input.toAddress,
    subject: `Invito a ${input.tenantName} su GarageOS`,
    html: renderInviteUserHtml(input),
    text: renderInviteUserText(input),
  });
}
