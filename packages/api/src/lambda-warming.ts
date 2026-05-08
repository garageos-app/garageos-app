// EventBridge Scheduler invokes this Lambda with payload {source: 'warming'}
// directly (no APIGW round-trip). The @fastify/aws-lambda adapter assumes
// APIGW v2 event shape; routing a non-APIGW event through it would crash
// at request-construction time. This higher-order handler short-circuits
// warming events before the adapter ever sees them.
//
// Performance: ~5ms warm response (vs ~50ms HTTP-based ping). ~3500
// invocations per month — well within the Lambda free tier. No DB queries,
// no Fastify routing setup, no logging side effects (the CloudWatch
// REPORT line records the invocation; that is sufficient for observability).
//
// Type approach: a permissive local LambdaHandler signature avoids adding
// @types/aws-lambda as a devDependency just for this one HOC. The function
// is structurally pure — it only inspects event.source and otherwise
// passes through to the inner handler. AWS Lambda runtime accepts any
// (event, context, callback?) => Promise<result> | result shape.

export type LambdaHandler = (
  event: unknown,
  context: unknown,
  callback?: unknown,
) => Promise<unknown> | unknown;

export function withWarmingGuard(inner: LambdaHandler): LambdaHandler {
  return async (event, context, callback) => {
    if (
      event &&
      typeof event === 'object' &&
      'source' in event &&
      (event as { source?: unknown }).source === 'warming'
    ) {
      return { ok: true, source: 'warming' };
    }
    return inner(event, context, callback);
  };
}
