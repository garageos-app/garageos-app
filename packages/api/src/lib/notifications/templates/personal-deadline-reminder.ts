// BR-297 / BR-298: personal deadline reminder email template.
// Sent by the cron sweep (H3) when a personal deadline nears or is overdue.
// Structural mirror of deadline-reminder.ts.
import type { PersonalDeadlineCategory } from '@garageos/database';

import type { CustomerForNotification, NotificationEvent } from '../types.js';

type PersonalDeadlineReminderEvent = Extract<
  NotificationEvent,
  { type: 'personal_deadline.reminder' }
>;

// Italian display names for PersonalDeadlineCategory values.
const CATEGORY_LABELS: Record<PersonalDeadlineCategory, string> = {
  insurance: 'Assicurazione',
  road_tax: 'Bollo',
  inspection: 'Revisione',
  service: 'Tagliando',
  tires: 'Pneumatici',
  timing_belt: 'Cinghia di distribuzione',
  other: 'Scadenza',
};

/**
 * Returns the human-readable Italian label for a personal deadline event.
 * For category 'other', returns customLabel when available; falls back to a
 * generic string so no null/undefined ever leaks into templates.
 * Exported so the push template (Task 3) can reuse it without drift.
 */
export function personalDeadlineLabel(event: PersonalDeadlineReminderEvent): string {
  if (event.category === 'other') {
    return event.customLabel ?? 'Scadenza';
  }
  return CATEGORY_LABELS[event.category];
}

/** Reformats a bare YYYY-MM-DD string to DD/MM/YYYY for Italian copy. */
function formatDDMMYYYY(isoDate: string): string {
  const [year, month, day] = isoDate.split('-');
  return `${day}/${month}/${year}`;
}

/** Produces the due-phrasing sentence based on daysUntilDue. */
function duePhrasing(event: PersonalDeadlineReminderEvent): string {
  const d = event.daysUntilDue;
  if (d > 0) {
    const giorni = d === 1 ? '1 giorno' : `${d} giorni`;
    return `Scade tra ${giorni} (${formatDDMMYYYY(event.dueDate)}).`;
  }
  if (d === 0) {
    return 'Scade oggi.';
  }
  // d < 0 — already overdue
  return `Era in scadenza il ${formatDDMMYYYY(event.dueDate)}.`;
}

function getRecipientDisplayName(c: CustomerForNotification): string {
  if (c.isBusiness && c.businessName) return c.businessName;
  return c.firstName ?? 'Cliente';
}

function getAppLink(): string {
  const baseUrl = process.env.WEB_APP_BASE_URL ?? 'https://app.garageos.aifollyadvisor.com';
  return `${baseUrl}/deadlines`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Subject line: "Promemoria scadenza: <label> — <plate>" */
export function renderPersonalDeadlineReminderSubject(
  event: PersonalDeadlineReminderEvent,
): string {
  return `Promemoria scadenza: ${personalDeadlineLabel(event)} — ${event.vehiclePlate}`;
}

interface RenderInput {
  recipient: CustomerForNotification;
  event: PersonalDeadlineReminderEvent;
}

export function renderPersonalDeadlineReminderHtml({ recipient, event }: RenderInput): string {
  const name = getRecipientDisplayName(recipient);
  const label = personalDeadlineLabel(event);
  const vehicleLabel = `${escapeHtml(event.vehicleMakeModel)} (${escapeHtml(event.vehiclePlate)})`;
  const phrasing = duePhrasing(event);
  const link = getAppLink();

  return `<!DOCTYPE html>
<html lang="it"><body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 16px;">
<h1>Ciao ${escapeHtml(name)},</h1>
<p>Ti ricordiamo che la scadenza <strong>${escapeHtml(label)}</strong> per il veicolo <strong>${vehicleLabel}</strong> si avvicina.</p>
<p>${escapeHtml(phrasing)}</p>
<p><a href="${link}" style="display: inline-block; background: #1d4ed8; color: white; padding: 10px 16px; text-decoration: none; border-radius: 4px;">Gestisci le tue scadenze nell'app</a></p>
<p style="color: #666; font-size: 12px; margin-top: 32px;">Ricevi questa email perché hai abilitato i promemoria sulle scadenze personali. Puoi disattivarli dalle impostazioni dell'app.</p>
</body></html>`;
}

export function renderPersonalDeadlineReminderText({ recipient, event }: RenderInput): string {
  const name = getRecipientDisplayName(recipient);
  const label = personalDeadlineLabel(event);
  const vehicleLabel = `${event.vehicleMakeModel} (${event.vehiclePlate})`;
  const phrasing = duePhrasing(event);
  const link = getAppLink();

  return `Ciao ${name},

Ti ricordiamo che la scadenza ${label} per il veicolo ${vehicleLabel} si avvicina.

${phrasing}

Gestisci le tue scadenze: ${link}

---
Ricevi questa email perché hai abilitato i promemoria sulle scadenze personali. Puoi disattivarli dalle impostazioni dell'app.`;
}
