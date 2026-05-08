import type { CustomerForNotification, InterventionForEmail, TenantForEmail } from '../types.js';

export const CANCELLATION_EMAIL_SUBJECT = 'Un intervento sul tuo veicolo è stato annullato';

interface CancellationTemplateInput {
  recipient: CustomerForNotification;
  intervention: InterventionForEmail;
  tenant: TenantForEmail;
}

function getRecipientDisplayName(c: CustomerForNotification): string {
  if (c.isBusiness && c.businessName) return c.businessName;
  return c.firstName ?? 'Cliente';
}

function getAppLink(vehicleId: string): string {
  return `https://app.garageos.aifollyadvisor.com/v/${vehicleId}`;
}

export function renderCancellationEmailHtml(input: CancellationTemplateInput): string {
  const name = getRecipientDisplayName(input.recipient);
  const link = getAppLink(input.intervention.vehicleId);
  const reasonBlock = input.intervention.cancelledReason
    ? `<p><strong>Motivo dell'annullamento:</strong> ${escapeHtml(input.intervention.cancelledReason)}</p>`
    : '';
  return `<!DOCTYPE html>
<html lang="it"><body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 16px;">
<h1>Ciao ${escapeHtml(name)},</h1>
<p>L'officina <strong>${escapeHtml(input.tenant.businessName)}</strong> ha annullato un intervento sul tuo veicolo.</p>
${reasonBlock}
<p><a href="${link}" style="display: inline-block; background: #1d4ed8; color: white; padding: 10px 16px; text-decoration: none; border-radius: 4px;">Vedi i dettagli nell'app</a></p>
<p style="color: #666; font-size: 12px; margin-top: 32px;">L'intervento resta visibile in timeline con badge "ANNULLATO" e motivazione (BR-066). Ricevi questa email perché sei iscritto agli aggiornamenti sui tuoi interventi.</p>
</body></html>`;
}

export function renderCancellationEmailText(input: CancellationTemplateInput): string {
  const name = getRecipientDisplayName(input.recipient);
  const link = getAppLink(input.intervention.vehicleId);
  const reasonBlock = input.intervention.cancelledReason
    ? `\nMotivo dell'annullamento: ${input.intervention.cancelledReason}\n`
    : '';
  return `Ciao ${name},

L'officina ${input.tenant.businessName} ha annullato un intervento sul tuo veicolo.
${reasonBlock}
Vedi i dettagli nell'app: ${link}

---
L'intervento resta visibile in timeline con badge "ANNULLATO" e motivazione (BR-066).
Ricevi questa email perché sei iscritto agli aggiornamenti sui tuoi interventi.`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
