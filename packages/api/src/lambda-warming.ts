// EventBridge Scheduler invokes this Lambda with payload {source: 'warming'}
// directly (no APIGW round-trip). The @fastify/aws-lambda adapter assumes
// APIGW v2 event shape; routing a non-APIGW event through it would crash
// at request-construction time. This higher-order handler short-circuits
// warming events before the adapter ever sees them.
//
// Why the warmup callback (post-#88 cold-start investigation):
//   A bare short-circuit keeps the JS runtime + container alive but does
//   NOT exercise the database connection pool or the Cognito JWKS cache —
//   both are lazy and pay their cost on the FIRST real request after a
//   cold container spawn (~3-5s for Prisma $connect + ~1-2s for JWKS).
//   The warmup callback runs a lightweight `SELECT 1` so the Prisma pool
//   is pre-established when real traffic lands. Net effect: the customer
//   never sees the cold-start tail during business hours.
//   Cost overhead: ~50-100ms per warming run × ~3500 invocations/mo = a
//   few cents/month, still within Lambda free tier.
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

export type WarmupCallback = () => Promise<unknown>;

export function withWarmingGuard(inner: LambdaHandler, warmup?: WarmupCallback): LambdaHandler {
  return async (event, context, callback) => {
    if (
      event &&
      typeof event === 'object' &&
      'source' in event &&
      (event as { source?: unknown }).source === 'warming'
    ) {
      let warmupOk = true;
      let warmupError: string | undefined;
      if (warmup) {
        try {
          await warmup();
        } catch (e) {
          // Don't fail the schedule — log the warmup error and return ok.
          // EventBridge Scheduler retry policy is `maximumRetryAttempts: 0`
          // anyway, and a failed warmup just means the next real request
          // pays the full cold-start (current baseline).
          warmupOk = false;
          warmupError = e instanceof Error ? e.message : String(e);
        }
      }
      // Single-line JSON for CloudWatch Logs filter pattern
      // '"source":"warming"' (F14.3 runbook). ~3500 lines/month, negligible cost.
      console.log(
        JSON.stringify({
          source: 'warming',
          ts: new Date().toISOString(),
          warmup: warmup ? (warmupOk ? 'ok' : 'failed') : 'skipped',
          ...(warmupError ? { error: warmupError } : {}),
        }),
      );
      return {
        ok: true,
        source: 'warming',
        warmup: warmup ? (warmupOk ? 'ok' : 'failed') : 'skipped',
      };
    }
    return inner(event, context, callback);
  };
}
