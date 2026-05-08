import { withWarmingGuard } from './lambda-warming.js';
import { withSchedulerGuard } from './lambda-scheduler.js';
import { loadSecretsIntoEnv } from './config/secrets.js';
import {
  processSchedulerInvocation,
  type SchedulerInvocationDetail,
  type SchedulerInvocationResult,
} from './lib/deadlines/scheduler-invocation.js';

// Step 1 of cold-start boot: hydrate process.env from Secrets Manager
// (APP_SECRETS_ARN is set by CDK in the Lambda env). No-op outside
// Lambda — local dev and tests rely on .env / .env.local.
await loadSecretsIntoEnv();

// Step 2: dynamic-import every module that reads env at module-load
// time. Static imports would parse env BEFORE step 1 had populated
// it, defeating the whole point of the Secrets Manager fetch.
const { buildServer } = await import('./server.js');
const { env } = await import('./config/env.js');
const awsLambdaFastify = (await import('@fastify/aws-lambda')).default;

const app = await buildServer();

// Wrap BEFORE the app starts. awsLambdaFastify decorates the request
// object with `awsLambda`; Fastify rejects decorator additions once
// the instance has started (FST_ERR_DEC_AFTER_START), which means we
// cannot await app.ready() before this line. The adapter awaits
// readiness internally on the first invocation.
//
// Wrapping order (outermost → innermost):
//   withWarmingGuard   — short-circuit {source:'warming'} events (G2)
//   withSchedulerGuard — short-circuit EventBridge Scheduler events (H3)
//   awsLambdaFastify   — real Fastify routing for APIGW v2 requests
const schedulerHandler = (detail: SchedulerInvocationDetail): Promise<SchedulerInvocationResult> =>
  processSchedulerInvocation({
    app: { withContext: app.withContext.bind(app), log: app.log },
    detail,
  });

export const handler = withWarmingGuard(
  withSchedulerGuard(schedulerHandler)(awsLambdaFastify(app)),
);

if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  try {
    await app.listen({ host: '0.0.0.0', port: env.PORT });
  } catch (err) {
    app.log.error({ err }, 'server failed to start');
    process.exit(1);
  }
}
