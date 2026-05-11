import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

// Production observability for the GarageOS API:
//   1. SNS AlertTopic — operator-driven email subscription post-deploy
//      via `aws sns subscribe` (see infrastructure/README.md F15.1).
//   2. 4 CloudWatch alarms:
//      - LambdaHighErrorRate — (Errors/Invocations)*100 > 5 over 5min
//      - LambdaHighDuration — Duration p95 > 3000ms over 2x5min eval
//      - LambdaThrottles — Throttles Sum > 10 in 5min (concurrency saturation)
//      - ApiGateway5xx — APIGW 5xx Sum > 10 in 5min (backend failures)
//   3. CloudWatch Dashboard `GarageOS-Production` with 4 GraphWidgets
//      (Invocations, Duration p50/p95/p99, APIGW 4xx/5xx, Concurrency&Throttles).
//
// Threshold rationale: see APPENDICE_C §5.11. Pilot-scale conservative;
// revisable post-pilot when traffic distribution data exists.
//
// X-Ray cold-start observability is OUT OF SCOPE: Tracing.ACTIVE already
// enabled on Lambda + APIGW (PR #29). Service map shows Initialization
// segment p99. Logs Insights query for cold-start% in F15.5 runbook.
//
// Sentry SDK wiring is OUT OF SCOPE: deferred to next PR (app-layer in
// packages/api/src/lib/sentry.ts). SENTRY_DSN placeholder already in
// SecretsConstruct (PR #29).

export interface MonitoringConstructProps {
  /**
   * Plain (non-token) function name used in CloudWatch metric dimensions.
   * Passing the literal (rather than lambdaFunction.functionName Ref token)
   * keeps the dimension lookup deterministic at synth time and avoids any
   * hidden token resolution in MathExpression usingMetrics.
   */
  readonly lambdaFunctionName: string;
  readonly httpApi: apigwv2.IHttpApi;
}

export class MonitoringConstruct extends Construct {
  public readonly alertTopic: sns.Topic;
  public readonly dashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string, props: MonitoringConstructProps) {
    super(scope, id);

    this.alertTopic = new sns.Topic(this, 'AlertTopic', {
      displayName: 'GarageOS Production Alerts',
      topicName: 'garageos-production-alerts',
    });

    const lambdaDims = { FunctionName: props.lambdaFunctionName };
    const apiDims = { ApiId: props.httpApi.apiId };

    new cloudwatch.Alarm(this, 'LambdaHighErrorRate', {
      alarmName: 'garageos-api-lambda-errors',
      alarmDescription: 'Lambda error rate > 5% over 5 minutes',
      metric: new cloudwatch.MathExpression({
        expression: '(errors / invocations) * 100',
        usingMetrics: {
          errors: new cloudwatch.Metric({
            namespace: 'AWS/Lambda',
            metricName: 'Errors',
            dimensionsMap: lambdaDims,
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
          }),
          invocations: new cloudwatch.Metric({
            namespace: 'AWS/Lambda',
            metricName: 'Invocations',
            dimensionsMap: lambdaDims,
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
          }),
        },
      }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cw_actions.SnsAction(this.alertTopic));

    // Threshold tuned to demo-phase reality: with the warming schedule
    // exercising Prisma every ~5 min during business hours (08-20 Europe/Rome,
    // MON-SAT), warm p95 sits well under 1s. The 5000ms threshold absorbs the
    // residual cold-start tail when AWS recycles a container outside the
    // warming window (e.g. weekend traffic, off-hours, or a 2nd concurrent
    // invocation that spawns a fresh container) without paging on every such
    // event. Tighten to ~1500ms at pilot beta when Provisioned Concurrency
    // becomes economically defensible. See feedback memory for the
    // investigation chain: warming guard + Prisma warmup callback (PR after
    // #88) was the actual fix for the customer-facing 10s first-hit.
    new cloudwatch.Alarm(this, 'LambdaHighDuration', {
      alarmName: 'garageos-api-lambda-duration',
      alarmDescription: 'Lambda p95 duration > 5s over 5 minutes (demo-phase tuned)',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/Lambda',
        metricName: 'Duration',
        dimensionsMap: lambdaDims,
        statistic: 'p95',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 5000,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    }).addAlarmAction(new cw_actions.SnsAction(this.alertTopic));

    new cloudwatch.Alarm(this, 'LambdaThrottles', {
      alarmName: 'garageos-api-lambda-throttles',
      alarmDescription: 'Lambda throttling events (reserved concurrency saturation)',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/Lambda',
        metricName: 'Throttles',
        dimensionsMap: lambdaDims,
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 10,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cw_actions.SnsAction(this.alertTopic));

    new cloudwatch.Alarm(this, 'ApiGateway5xx', {
      alarmName: 'garageos-api-apigw-5xx',
      alarmDescription: 'API Gateway 5xx responses (backend failures)',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApiGateway',
        metricName: '5xx',
        dimensionsMap: apiDims,
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 10,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cw_actions.SnsAction(this.alertTopic));

    this.dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: 'GarageOS-Production',
    });

    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'API Requests (Invocations)',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/Lambda',
            metricName: 'Invocations',
            dimensionsMap: lambdaDims,
            statistic: 'Sum',
          }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda Duration',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/Lambda',
            metricName: 'Duration',
            dimensionsMap: lambdaDims,
            statistic: 'p50',
            label: 'p50',
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/Lambda',
            metricName: 'Duration',
            dimensionsMap: lambdaDims,
            statistic: 'p95',
            label: 'p95',
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/Lambda',
            metricName: 'Duration',
            dimensionsMap: lambdaDims,
            statistic: 'p99',
            label: 'p99',
          }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'API Gateway Errors',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/ApiGateway',
            metricName: '4xx',
            dimensionsMap: apiDims,
            statistic: 'Sum',
            label: '4xx',
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/ApiGateway',
            metricName: '5xx',
            dimensionsMap: apiDims,
            statistic: 'Sum',
            label: '5xx',
          }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda Concurrency & Throttles',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/Lambda',
            metricName: 'ConcurrentExecutions',
            dimensionsMap: lambdaDims,
            statistic: 'Maximum',
            label: 'Concurrent (max)',
          }),
        ],
        right: [
          new cloudwatch.Metric({
            namespace: 'AWS/Lambda',
            metricName: 'Throttles',
            dimensionsMap: lambdaDims,
            statistic: 'Sum',
            label: 'Throttles',
          }),
        ],
      }),
    );
  }
}
