import type { LambdaHandler } from './lambda-warming.js';
import type { PersonalDeadlineSweepResult } from './lib/personal-deadlines/sweep.js';

export type PersonalDeadlineSweepHandler = () => Promise<PersonalDeadlineSweepResult>;

// Short-circuit EventBridge Scheduler invocations carrying the daily
// personal-deadline-sweep payload before they reach the @fastify/aws-lambda
// adapter (which assumes APIGW v2 event shape and would crash on a non-APIGW
// event). Pattern mirrors withWarmingGuard: the schedule's `input` JSON IS the
// event, so we match a top-level `source: 'personal-deadline-sweep'`. That value
// is disjoint from 'warming' (withWarmingGuard), 'transfer-expiry'
// (withTransferExpiryGuard), and 'aws.scheduler' (withSchedulerGuard), so the
// guards never collide.
//
// Wrapping order in the Lambda entry (outermost to innermost):
//   withWarmingGuard(withTransferExpiryGuard(withPersonalDeadlineSweepGuard(withSchedulerGuard(...)(adapter), handler), transferExpiryHandler), warmup)
export function withPersonalDeadlineSweepGuard(
  inner: LambdaHandler,
  handler: PersonalDeadlineSweepHandler,
): LambdaHandler {
  return async (event, context, callback) => {
    if (
      event &&
      typeof event === 'object' &&
      'source' in event &&
      (event as { source?: unknown }).source === 'personal-deadline-sweep'
    ) {
      return handler();
    }
    return inner(event, context, callback);
  };
}
