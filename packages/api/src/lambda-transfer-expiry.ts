import type { LambdaHandler } from './lambda-warming.js';
import type { TransferExpiryResult } from './lib/transfers/expire-transfers.js';

export type TransferExpiryHandler = () => Promise<TransferExpiryResult>;

// Short-circuit EventBridge Scheduler invocations carrying the daily
// transfer-expiry payload before they reach the @fastify/aws-lambda adapter
// (which assumes APIGW v2 event shape and would crash on a non-APIGW event).
// Pattern mirrors withWarmingGuard: the schedule's `input` JSON IS the event,
// so we match a top-level `source: 'transfer-expiry'`. That value is disjoint
// from 'warming' (withWarmingGuard) and 'aws.scheduler' (withSchedulerGuard),
// so the three guards never collide.
//
// Wrapping order in the Lambda entry (outermost to innermost):
//   withWarmingGuard(withTransferExpiryGuard(withSchedulerGuard(...)(adapter), handler), warmup)
export function withTransferExpiryGuard(
  inner: LambdaHandler,
  handler: TransferExpiryHandler,
): LambdaHandler {
  return async (event, context, callback) => {
    if (
      event &&
      typeof event === 'object' &&
      'source' in event &&
      (event as { source?: unknown }).source === 'transfer-expiry'
    ) {
      return handler();
    }
    return inner(event, context, callback);
  };
}
