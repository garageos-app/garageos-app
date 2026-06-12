import { deliverEmail, type EmailMessage } from '../email/transport.js';

export type SendEmailInput = EmailMessage;

// Thin wrapper around the provider-agnostic transport (lib/email/transport.ts).
// This module is the single seam where notification-style emails go out;
// templates do NOT call the transport directly. Throws on env-vars-missing
// or any provider-side error — the dispatcher wraps the call in try/catch.
export async function sendEmail(input: SendEmailInput): Promise<void> {
  await deliverEmail(input);
}
