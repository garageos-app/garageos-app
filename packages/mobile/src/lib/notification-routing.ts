// Pure mapping from a push notification `data` payload to an expo-router href.
// The payload shape is produced server-side by
// packages/api/src/lib/notifications/push-templates.ts — the two must stay in
// sync. No native imports here so the module is testable without expo mocks.

// Structural subset of expo-notifications' NotificationResponse. On Android,
// when a tap launches the app from the killed state, the FCM payload may not
// be hydrated into content.data and instead lives as a JSON string under
// trigger.remoteMessage.data.body — extractNotificationData handles both.
export interface NotificationResponseLike {
  notification: {
    request: {
      content: { data?: unknown };
      trigger?: unknown;
    };
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseNotificationTarget(data: unknown): string | null {
  if (!isPlainObject(data)) return null;
  switch (data.type) {
    case 'intervention.revised':
    case 'intervention.cancelled':
      return isNonEmptyString(data.interventionId)
        ? `/interventions/${encodeURIComponent(data.interventionId)}`
        : null;
    case 'deadline.reminder':
      return isNonEmptyString(data.deadlineId)
        ? `/(tabs)/deadlines?highlight=${encodeURIComponent(data.deadlineId)}`
        : null;
    case 'ownership.transferred':
      // Recipient is the PREVIOUS owner — the vehicle detail would 404 for
      // them, so land on the vehicles list instead.
      return '/(tabs)';
    default:
      return null;
  }
}

export function extractNotificationData(response: NotificationResponseLike): unknown {
  const { content, trigger } = response.notification.request;
  if (isPlainObject(content.data) && Object.keys(content.data).length > 0) {
    return content.data;
  }
  if (isPlainObject(trigger) && isPlainObject(trigger.remoteMessage)) {
    const remoteData = trigger.remoteMessage.data;
    if (isPlainObject(remoteData) && isNonEmptyString(remoteData.body)) {
      try {
        return JSON.parse(remoteData.body);
      } catch {
        return null;
      }
    }
  }
  return null;
}
