import type { NotificationEvent } from './types.js';

// Pure title/body/data renderer for Expo push. Italian, short (title ≤ ~40,
// body ≤ ~120 char). `data` carries the routing hints the mobile app will use
// for tap-to-screen (not consumed in PR2). Mirrors the email subjects.
export interface PushPayload {
  title: string;
  body: string;
  data: Record<string, string>;
}

export function renderPushPayload(event: NotificationEvent): PushPayload {
  switch (event.type) {
    case 'intervention.revised':
      return {
        title: 'Intervento aggiornato',
        body: `${event.tenant.businessName} ha modificato un intervento sul tuo veicolo.`,
        data: {
          type: 'intervention.revised',
          interventionId: event.intervention.id,
          vehicleId: event.intervention.vehicleId,
        },
      };
    case 'intervention.cancelled':
      return {
        title: 'Intervento annullato',
        body: `${event.tenant.businessName} ha annullato un intervento sul tuo veicolo.`,
        data: {
          type: 'intervention.cancelled',
          interventionId: event.intervention.id,
          vehicleId: event.intervention.vehicleId,
        },
      };
    case 'deadline.reminder':
      return {
        title: 'Scadenza in arrivo',
        body: `${event.interventionTypeName} per ${event.vehicleLicensePlate} è in scadenza.`,
        data: {
          type: 'deadline.reminder',
          deadlineId: event.deadlineId,
          vehicleId: event.vehicleId,
        },
      };
    case 'ownership.transferred':
      return {
        title: 'Veicolo trasferito',
        body: `La proprietà del veicolo ${event.vehicle.plate} è stata trasferita.`,
        data: {
          type: 'ownership.transferred',
          vehicleId: event.vehicle.id,
        },
      };
  }
}
