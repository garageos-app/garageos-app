// BR-157: a new officina intervention always notifies the current owner
// (push + email). Gated upstream by the intervention_updates preference
// toggle (BR-226 v1.3). Structural mirror of intervention-cancelled.ts.
import type {
  CustomerForNotification,
  InterventionForEmail,
  TenantForEmail,
  VehicleForCreatedEmail,
} from '../types.js';

export const CREATED_EMAIL_SUBJECT = 'Nuovo intervento registrato sul tuo veicolo';

interface CreatedTemplateInput {
  recipient: CustomerForNotification;
  intervention: InterventionForEmail;
  interventionTypeName: string;
  vehicle: VehicleForCreatedEmail;
  tenant: TenantForEmail;
}

function getRecipientDisplayName(c: CustomerForNotification): string {
  if (c.isBusiness && c.businessName) return c.businessName;
  return c.firstName ?? 'Cliente';
}

function getAppLink(vehicleId: string): string {
  return `https://app.garageos.aifollyadvisor.com/v/${vehicleId}`;
}

export function renderCreatedEmailHtml(input: CreatedTemplateInput): string {
  const name = getRecipientDisplayName(input.recipient);
  const link = getAppLink(input.intervention.vehicleId);
  const vehicleLabel = `${input.vehicle.make} ${input.vehicle.model} (${input.vehicle.plate})`;
  return `<!DOCTYPE html>
<html lang="it"><body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 16px;">
<h1>Ciao ${escapeHtml(name)},</h1>
<p>L'officina <strong>${escapeHtml(input.tenant.businessName)}</strong> ha registrato un nuovo intervento sul tuo veicolo <strong>${escapeHtml(vehicleLabel)}</strong>.</p>
<p><strong>Tipo di intervento:</strong> ${escapeHtml(input.interventionTypeName)}</p>
<p><a href="${link}" style="display: inline-block; background: #1d4ed8; color: white; padding: 10px 16px; text-decoration: none; border-radius: 4px;">Vedi i dettagli nell'app</a></p>
<p style="color: #666; font-size: 12px; margin-top: 32px;">Ricevi questa email perché sei iscritto agli aggiornamenti sui tuoi interventi.</p>
</body></html>`;
}

export function renderCreatedEmailText(input: CreatedTemplateInput): string {
  const name = getRecipientDisplayName(input.recipient);
  const link = getAppLink(input.intervention.vehicleId);
  const vehicleLabel = `${input.vehicle.make} ${input.vehicle.model} (${input.vehicle.plate})`;
  return `Ciao ${name},

L'officina ${input.tenant.businessName} ha registrato un nuovo intervento sul tuo veicolo ${vehicleLabel}.

Tipo di intervento: ${input.interventionTypeName}

Vedi i dettagli nell'app: ${link}

---
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
