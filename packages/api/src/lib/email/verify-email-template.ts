// HTML escape for XSS hardening. customerName flows from Zod-validated
// signup body but defense-in-depth applies — once the email lands in
// the user's inbox, anything that renders as HTML is the recipient's
// trust boundary, not ours.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderVerifyEmailText(customerName: string, verificationUrl: string): string {
  return `Ciao ${customerName},

Benvenuto in GarageOS! Per attivare il tuo account, conferma il tuo
indirizzo email cliccando il link qui sotto:

${verificationUrl}

Il link è valido per 24 ore. Se non hai richiesto questa registrazione,
puoi ignorare questa email — l'account non verrà attivato.

—
GarageOS — il libretto digitale del tuo veicolo
https://app.garageos.aifollyadvisor.com
`;
}

export function renderVerifyEmailHtml(customerName: string, verificationUrl: string): string {
  const safeName = escapeHtml(customerName);
  const safeUrl = verificationUrl; // already URL-encoded server-side, no HTML escaping needed for href

  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Verifica email — GarageOS</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#ffffff;border-radius:12px;padding:40px 32px;">
      <tr><td>
        <h1 style="margin:0 0 16px;font-size:24px;font-weight:600;color:#0f172a;">Benvenuto in GarageOS</h1>
        <p style="margin:0 0 24px;font-size:16px;line-height:1.5;color:#334155;">
          Ciao <strong>${safeName}</strong>, conferma il tuo indirizzo email per attivare il tuo account.
        </p>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;">
          <tr><td style="border-radius:8px;background:#0f172a;">
            <a href="${safeUrl}" style="display:inline-block;padding:14px 28px;font-size:16px;font-weight:500;color:#ffffff;text-decoration:none;border-radius:8px;">Conferma email</a>
          </td></tr>
        </table>
        <p style="margin:0 0 16px;font-size:14px;line-height:1.5;color:#64748b;">Oppure copia e incolla questo URL nel browser:</p>
        <p style="margin:0 0 24px;font-size:13px;line-height:1.5;color:#64748b;word-break:break-all;">
          <a href="${safeUrl}" style="color:#0ea5e9;">${safeUrl}</a>
        </p>
        <p style="margin:0 0 16px;font-size:14px;line-height:1.5;color:#64748b;">
          Il link è valido per <strong>24 ore</strong>. Se non hai richiesto questa registrazione, puoi ignorare questa email.
        </p>
      </td></tr>
      <tr><td style="padding-top:32px;border-top:1px solid #e2e8f0;">
        <p style="margin:0;font-size:12px;line-height:1.5;color:#94a3b8;">
          GarageOS — il libretto digitale del tuo veicolo<br>
          <a href="https://app.garageos.aifollyadvisor.com" style="color:#94a3b8;">app.garageos.aifollyadvisor.com</a>
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}
