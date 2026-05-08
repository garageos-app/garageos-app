import type {
  CustomerForNotification,
  DeadlineReminderForEmail,
  DeadlineReminderType,
  NotificationEvent,
} from '../types.js';

type DeadlineReminderEvent = Extract<NotificationEvent, { type: 'deadline.reminder' }>;

const ITALIAN_MONTHS = [
  'gennaio',
  'febbraio',
  'marzo',
  'aprile',
  'maggio',
  'giugno',
  'luglio',
  'agosto',
  'settembre',
  'ottobre',
  'novembre',
  'dicembre',
];

function formatItalianDate(isoDate: string): string {
  const [yearStr, monthStr, dayStr] = isoDate.split('-');
  const year = parseInt(yearStr!, 10);
  const month = parseInt(monthStr!, 10);
  const day = parseInt(dayStr!, 10);
  return `${day} ${ITALIAN_MONTHS[month - 1]} ${year}`;
}

function formatItalianKm(km: number): string {
  return `${km.toLocaleString('it-IT')} km`;
}

function recipientGreeting(recipient: CustomerForNotification): string {
  if (recipient.isBusiness && recipient.businessName) return `Buongiorno ${recipient.businessName}`;
  if (recipient.firstName) return `Ciao ${recipient.firstName}`;
  return 'Buongiorno';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// renderDeadlineReminderSubject accepts either the full event or just the
// DeadlineReminderForEmail payload, so callers that only have the payload
// (e.g. tests) don't need to wrap it.
export function renderDeadlineReminderSubject(
  event: DeadlineReminderEvent | DeadlineReminderForEmail,
): string {
  const e = event as DeadlineReminderForEmail;
  switch (e.reminderType) {
    case 't_minus_30':
      return `Promemoria: scadenza ${e.interventionTypeName} fra 30 giorni — ${e.vehicleLicensePlate}`;
    case 't_minus_7':
      return `Promemoria urgente: ${e.interventionTypeName} scade fra 7 giorni — ${e.vehicleLicensePlate}`;
    case 't_zero':
      return `Oggi scade: ${e.interventionTypeName} — ${e.vehicleLicensePlate}`;
    case 'km_reached':
      // km_reached is a no-op enum value — date-driven reminders only for H3.
      // Kept for forward compatibility with future km-tracking infrastructure.
      return `Promemoria: ${e.interventionTypeName} — ${e.vehicleLicensePlate}`;
  }
}

function headlineForReminder(reminderType: DeadlineReminderType, typeName: string): string {
  switch (reminderType) {
    case 't_minus_30':
      return `tra 30 giorni scade ${typeName} sul tuo veicolo.`;
    case 't_minus_7':
      return `mancano 7 giorni alla scadenza ${typeName}. Ti ricordiamo di prenotare per tempo.`;
    case 't_zero':
      return `oggi scade ${typeName} sul tuo veicolo.`;
    case 'km_reached':
      return `${typeName} è in scadenza.`;
  }
}

interface RenderInput {
  recipient: CustomerForNotification;
  event: DeadlineReminderEvent;
}

export function renderDeadlineReminderHtml({ recipient, event }: RenderInput): string {
  const baseUrl = process.env.WEB_APP_BASE_URL ?? 'https://app.garageos.aifollyadvisor.com';
  const link = `${baseUrl}/vehicles/${event.vehicleId}`;
  const dueLabel = formatItalianDate(event.dueDate);
  const kmBlock =
    event.dueOdometerKm != null
      ? `<p class="km">Scadenza prevista anche a ${formatItalianKm(event.dueOdometerKm)}.</p>`
      : '';
  const descBlock = event.description
    ? `<p class="description">${escapeHtml(event.description)}</p>`
    : '';
  const greeting = recipientGreeting(recipient);
  const headline = headlineForReminder(event.reminderType, event.interventionTypeName);

  return `<!doctype html>
<html lang="it">
  <body>
    <p>${escapeHtml(greeting)},</p>
    <p>${escapeHtml(headline)}</p>
    <p><strong>${escapeHtml(event.interventionTypeName)}</strong> — Targa <strong>${escapeHtml(event.vehicleLicensePlate)}</strong></p>
    <p>Data di scadenza: <strong>${dueLabel}</strong></p>
    ${kmBlock}
    ${descBlock}
    <p><a href="${link}">Apri il veicolo nell'app GarageOS</a></p>
    <p style="font-size:12px;color:#666;">
      Stai ricevendo questa email perché hai abilitato i promemoria sulle scadenze.
      Puoi disattivarli dalle impostazioni dell'app.
    </p>
  </body>
</html>`;
}

export function renderDeadlineReminderText({ recipient, event }: RenderInput): string {
  const baseUrl = process.env.WEB_APP_BASE_URL ?? 'https://app.garageos.aifollyadvisor.com';
  const link = `${baseUrl}/vehicles/${event.vehicleId}`;
  const dueLabel = formatItalianDate(event.dueDate);
  const greeting = recipientGreeting(recipient);
  const headline = headlineForReminder(event.reminderType, event.interventionTypeName);

  const lines: string[] = [
    `${greeting},`,
    '',
    headline,
    '',
    `${event.interventionTypeName} — Targa ${event.vehicleLicensePlate}`,
    `Data di scadenza: ${dueLabel}`,
  ];
  if (event.dueOdometerKm != null) {
    lines.push(`Scadenza prevista anche a ${formatItalianKm(event.dueOdometerKm)}.`);
  }
  if (event.description) {
    lines.push('');
    lines.push(event.description);
  }
  lines.push(
    '',
    `Apri il veicolo: ${link}`,
    '',
    "Puoi disattivare i promemoria dalle impostazioni dell'app.",
  );
  return lines.join('\n');
}
