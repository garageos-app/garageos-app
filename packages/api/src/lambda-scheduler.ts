import type { LambdaHandler } from './lambda-warming.js';
import type {
  SchedulerInvocationDetail,
  SchedulerInvocationResult,
} from './lib/deadlines/scheduler-invocation.js';

type SchedulerHandler = (detail: SchedulerInvocationDetail) => Promise<SchedulerInvocationResult>;

// Short-circuit EventBridge Scheduler invocations of the API Lambda
// before they reach Fastify. Pattern mirrors withWarmingGuard from G2.
//
// Match: event.source === 'aws.scheduler' AND event.detail has both
// deadlineNotificationId AND reminderType strings. The detail double
// check guards against future schedule shapes that aren't deadline
// reminders.
//
// Wrapping order in the Lambda entry (outermost to innermost):
//   withWarmingGuard(withTransferExpiryGuard(withSchedulerGuard(schedulerHandler)(awsLambdaFastify(app)), handler), warmup)
export function withSchedulerGuard(handler: SchedulerHandler) {
  return (inner: LambdaHandler): LambdaHandler => {
    return async (event, context, callback) => {
      if (
        event &&
        typeof event === 'object' &&
        'source' in event &&
        (event as { source?: unknown }).source === 'aws.scheduler' &&
        'detail' in event
      ) {
        const detail = (event as { detail?: unknown }).detail;
        if (
          detail &&
          typeof detail === 'object' &&
          'deadlineNotificationId' in detail &&
          'reminderType' in detail &&
          typeof (detail as { deadlineNotificationId?: unknown }).deadlineNotificationId ===
            'string' &&
          typeof (detail as { reminderType?: unknown }).reminderType === 'string'
        ) {
          return handler({
            deadlineNotificationId: (detail as { deadlineNotificationId: string })
              .deadlineNotificationId,
            reminderType: (detail as { reminderType: SchedulerInvocationDetail['reminderType'] })
              .reminderType,
          });
        }
      }
      return inner(event, context, callback);
    };
  };
}
