import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

// Provider-agnostic email transport. Every outbound email (verify-email,
// invitations, notification channel) funnels through deliverEmail(); the
// EMAIL_PROVIDER env var selects the backend:
//   - 'ses' (default): SESv2 SendEmailCommand — kept as the fallback path
//     so the switch is reversible if AWS lifts the sandbox restriction.
//   - 'resend': Resend HTTP API via global fetch (no SDK dependency).
//     RESEND_API_KEY arrives through the app secret hydration
//     (config/secrets.ts); the from address reuses SES_FROM_ADDRESS so
//     both providers share a single source of truth.
// Errors always propagate to the caller — callers decide whether the
// send is best-effort (signup verify) or part of a dispatcher loop.

export interface EmailMessage {
  toAddress: string;
  subject: string;
  html: string;
  text: string;
}

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

export async function deliverEmail(message: EmailMessage): Promise<void> {
  const provider = process.env.EMAIL_PROVIDER ?? 'ses';
  if (provider === 'resend') return deliverViaResend(message);
  if (provider === 'ses') return deliverViaSes(message);
  throw new Error(`Unknown EMAIL_PROVIDER: ${provider}`);
}

async function deliverViaSes(message: EmailMessage): Promise<void> {
  const fromAddress = process.env.SES_FROM_ADDRESS;
  const configurationSet = process.env.SES_CONFIGURATION_SET;
  if (!fromAddress || !configurationSet) {
    throw new Error('SES env vars missing');
  }
  await getSesClient().send(
    new SendEmailCommand({
      FromEmailAddress: fromAddress,
      Destination: { ToAddresses: [message.toAddress] },
      ConfigurationSetName: configurationSet,
      Content: {
        Simple: {
          Subject: { Data: message.subject, Charset: 'UTF-8' },
          Body: {
            Html: { Data: message.html, Charset: 'UTF-8' },
            Text: { Data: message.text, Charset: 'UTF-8' },
          },
        },
      },
    }),
  );
}

async function deliverViaResend(message: EmailMessage): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const fromAddress = process.env.SES_FROM_ADDRESS;
  if (!apiKey || !fromAddress) {
    throw new Error('Resend env vars missing');
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    // Bound the call well below the 30s Lambda timeout: a hung Resend
    // request must not burn the whole invocation (scheduler path awaits
    // the dispatcher directly).
    signal: AbortSignal.timeout(10_000),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromAddress,
      to: [message.toAddress],
      subject: message.subject,
      html: message.html,
      text: message.text,
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '<unreadable body>');
    throw new Error(`Resend send failed: ${response.status} ${body}`);
  }
}
