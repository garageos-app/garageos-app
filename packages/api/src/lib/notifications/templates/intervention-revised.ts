import type {
  CustomerForNotification,
  InterventionForEmail,
  RevisionForEmail,
  TenantForEmail,
} from '../types.js';

export const REVISION_EMAIL_SUBJECT = 'Un intervento sul tuo veicolo è stato modificato';

interface RevisionTemplateInput {
  recipient: CustomerForNotification;
  intervention: InterventionForEmail;
  revision: RevisionForEmail;
  tenant: TenantForEmail;
}

function getRecipientDisplayName(c: CustomerForNotification): string {
  if (c.isBusiness && c.businessName) return c.businessName;
  return c.firstName ?? 'Cliente';
}

function getAppLink(vehicleId: string): string {
  return `https://app.garageos.aifollyadvisor.com/v/${vehicleId}`;
}

export function renderRevisionEmailHtml(input: RevisionTemplateInput): string {
  const name = getRecipientDisplayName(input.recipient);
  const link = getAppLink(input.intervention.vehicleId);
  const reasonBlock = input.revision.reason
    ? `<p><strong>Motivo della modifica:</strong> ${escapeHtml(input.revision.reason)}</p>`
    : '';
  return `<!DOCTYPE html>
<html lang="it"><body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 16px;">
<h1>Ciao ${escapeHtml(name)},</h1>
<p>L'officina <strong>${escapeHtml(input.tenant.businessName)}</strong> ha modificato un intervento sul tuo veicolo.</p>
${reasonBlock}
<p><a href="${link}" style="display: inline-block; background: #1d4ed8; color: white; padding: 10px 16px; text-decoration: none; border-radius: 4px;">Vedi i dettagli nell'app</a></p>
<p style="color: #666; font-size: 12px; margin-top: 32px;">Ricevi questa email perché sei iscritto agli aggiornamenti sui tuoi interventi (BR-064). Puoi modificare le preferenze nelle impostazioni dell'app.</p>
</body></html>`;
}

export function renderRevisionEmailText(input: RevisionTemplateInput): string {
  const name = getRecipientDisplayName(input.recipient);
  const link = getAppLink(input.intervention.vehicleId);
  const reasonBlock = input.revision.reason
    ? `\nMotivo della modifica: ${input.revision.reason}\n`
    : '';
  return `Ciao ${name},

L'officina ${input.tenant.businessName} ha modificato un intervento sul tuo veicolo.
${reasonBlock}
Vedi i dettagli nell'app: ${link}

---
Ricevi questa email perché sei iscritto agli aggiornamenti sui tuoi interventi (BR-064).
Puoi modificare le preferenze nelle impostazioni dell'app.`;
}

// Minimal HTML escape — only the 5 chars that break attributes/text.
// We don't render arbitrary user HTML so this is sufficient.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
