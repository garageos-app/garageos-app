import type { NotificationEvent, NotificationEventPrefKey } from './types.js';

// Maps each event type to the preference key that gates it on BOTH channels.
// intervention.* → intervention_updates; deadline.reminder → deadline_reminder;
// ownership.transferred → ownership_transfer. (Extracted from dispatcher.ts so
// push-channel can reuse it without an import cycle.)
export function preferenceKeyForEvent(event: NotificationEvent): NotificationEventPrefKey {
  switch (event.type) {
    case 'intervention.revised':
    case 'intervention.cancelled':
      return 'intervention_updates';
    case 'deadline.reminder':
      return 'deadline_reminder';
    case 'ownership.transferred':
      return 'ownership_transfer';
  }
}
