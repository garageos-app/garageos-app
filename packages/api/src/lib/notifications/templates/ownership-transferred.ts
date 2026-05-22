import type { CustomerForNotification, TenantForEmail } from '../types.js';

export const OWNERSHIP_TRANSFERRED_SUBJECT = 'La proprietà del tuo veicolo è stata trasferita';

type TransferReason = 'purchase' | 'inheritance' | 'company_assignment' | 'other';

interface OwnershipTransferredTemplateInput {
  recipient: CustomerForNotification;
  vehicle: { id: string; plate: string };
  tenant: TenantForEmail;
  transferReason: TransferReason;
  transferredAt: string; // ISO 8601
}

const REASON_LABELS: Record<TransferReason, string> = {
  purchase: 'Vendita',
  inheritance: 'Eredità',
  company_assignment: 'Assegnazione aziendale',
  other: 'Altro',
};

function getRecipientDisplayName(c: CustomerForNotification): string {
  if (c.isBusiness && c.businessName) return c.businessName;
  return c.firstName ?? 'Cliente';
}

// Format an ISO timestamp to DD/MM/YYYY. Manual formatting (not
// toLocaleDateString) keeps the output deterministic across runtimes.
function formatItDate(iso: string): string {
  const d = new Date(iso);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

export function renderOwnershipTransferredHtml(input: OwnershipTransferredTemplateInput): string {
  const name = getRecipientDisplayName(input.recipient);
  const date = formatItDate(input.transferredAt);
  const reason = REASON_LABELS[input.transferReason];
  return `<!DOCTYPE html>
<html lang="it"><body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 16px;">
<h1>Ciao ${escapeHtml(name)},</h1>
<p>Ti informiamo che la proprietà del veicolo con targa <strong>${escapeHtml(input.vehicle.plate)}</strong> è stata trasferita in data <strong>${escapeHtml(date)}</strong> dall'officina <strong>${escapeHtml(input.tenant.businessName)}</strong>.</p>
<p><strong>Motivo del trasferimento:</strong> ${escapeHtml(reason)}</p>
<p style="color: #666; font-size: 12px; margin-top: 32px;">Da questo momento non avrai più accesso allo storico interventi di questo veicolo (BR-045). Ricevi questa email perché risultavi proprietario di un veicolo registrato presso un'officina GarageOS.</p>
</body></html>`;
}

export function renderOwnershipTransferredText(input: OwnershipTransferredTemplateInput): string {
  const name = getRecipientDisplayName(input.recipient);
  const date = formatItDate(input.transferredAt);
  const reason = REASON_LABELS[input.transferReason];
  return `Ciao ${name},

Ti informiamo che la proprietà del veicolo con targa ${input.vehicle.plate} è stata trasferita in data ${date} dall'officina ${input.tenant.businessName}.

Motivo del trasferimento: ${reason}

---
Da questo momento non avrai più accesso allo storico interventi di questo veicolo (BR-045).
Ricevi questa email perché risultavi proprietario di un veicolo registrato presso un'officina GarageOS.`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
