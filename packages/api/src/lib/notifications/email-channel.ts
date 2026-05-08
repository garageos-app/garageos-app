import { SendEmailCommand } from '@aws-sdk/client-sesv2';

import { getSesClient } from '../ses-client.js';

export interface SendEmailInput {
  toAddress: string;
  subject: string;
  html: string;
  text: string;
}

// Thin wrapper around the lazy SES client singleton (see lib/ses-client.ts).
// This module is the single seam where notification-style emails go out;
// templates do NOT call SES directly. Throws on env-vars-missing or any
// SES-side error — the dispatcher wraps the call in try/catch.
export async function sendEmail(input: SendEmailInput): Promise<void> {
  const fromAddress = process.env.SES_FROM_ADDRESS;
  const configurationSet = process.env.SES_CONFIGURATION_SET;
  if (!fromAddress || !configurationSet) {
    throw new Error('SES env vars missing');
  }
  await getSesClient().send(
    new SendEmailCommand({
      FromEmailAddress: fromAddress,
      Destination: { ToAddresses: [input.toAddress] },
      ConfigurationSetName: configurationSet,
      Content: {
        Simple: {
          Subject: { Data: input.subject, Charset: 'UTF-8' },
          Body: {
            Html: { Data: input.html, Charset: 'UTF-8' },
            Text: { Data: input.text, Charset: 'UTF-8' },
          },
        },
      },
    }),
  );
}
