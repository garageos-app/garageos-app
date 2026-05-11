import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { MonitoringConstruct } from '../lib/constructs/monitoring.js';

function buildStack() {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack', {
    env: { account: '111122223333', region: 'eu-central-1' },
  });
  // Use fromHttpApiAttributes so httpApi.apiId is a plain literal string at
  // synth time. If we use `new apigwv2.HttpApi(...)` instead, apiId becomes a
  // CFN Ref token and CDK renders DashboardBody as Fn::Join (not a parseable
  // JSON string), which would break the widget-title assertion below.
  const httpApi = apigwv2.HttpApi.fromHttpApiAttributes(stack, 'MockApi', {
    httpApiId: 'abc1234567',
  });
  const construct = new MonitoringConstruct(stack, 'Monitoring', {
    lambdaFunctionName: 'garageos-api',
    httpApi,
  });
  return { stack, construct };
}

describe('MonitoringConstruct', () => {
  it('creates SNS Topic with display name and topic name', () => {
    const { stack } = buildStack();
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::SNS::Topic', {
      DisplayName: 'GarageOS Production Alerts',
      TopicName: 'garageos-production-alerts',
    });
  });

  it('creates LambdaHighErrorRate alarm with MathExpression and 5% threshold', () => {
    const { stack } = buildStack();
    const template = Template.fromStack(stack);
    template.hasResourceProperties(
      'AWS::CloudWatch::Alarm',
      Match.objectLike({
        AlarmName: 'garageos-api-lambda-errors',
        Threshold: 5,
        EvaluationPeriods: 1,
        ComparisonOperator: 'GreaterThanThreshold',
        TreatMissingData: 'notBreaching',
        Metrics: Match.arrayWith([
          Match.objectLike({ Expression: '(errors / invocations) * 100' }),
        ]),
      }),
    );
  });

  it('creates LambdaHighDuration alarm p95 > 5000ms with 2 evaluation periods', () => {
    const { stack } = buildStack();
    const template = Template.fromStack(stack);
    template.hasResourceProperties(
      'AWS::CloudWatch::Alarm',
      Match.objectLike({
        AlarmName: 'garageos-api-lambda-duration',
        Threshold: 5000,
        EvaluationPeriods: 2,
        MetricName: 'Duration',
        Namespace: 'AWS/Lambda',
        ExtendedStatistic: 'p95',
      }),
    );
  });

  it('creates LambdaThrottles alarm > 10 with NOT_BREACHING', () => {
    const { stack } = buildStack();
    const template = Template.fromStack(stack);
    template.hasResourceProperties(
      'AWS::CloudWatch::Alarm',
      Match.objectLike({
        AlarmName: 'garageos-api-lambda-throttles',
        Threshold: 10,
        MetricName: 'Throttles',
        Namespace: 'AWS/Lambda',
        Statistic: 'Sum',
        TreatMissingData: 'notBreaching',
      }),
    );
  });

  it('creates ApiGateway5xx alarm > 10 with APIGW namespace', () => {
    const { stack } = buildStack();
    const template = Template.fromStack(stack);
    template.hasResourceProperties(
      'AWS::CloudWatch::Alarm',
      Match.objectLike({
        AlarmName: 'garageos-api-apigw-5xx',
        Threshold: 10,
        MetricName: '5xx',
        Namespace: 'AWS/ApiGateway',
        Statistic: 'Sum',
        TreatMissingData: 'notBreaching',
      }),
    );
  });

  it('all 4 alarms wire AlertTopic via SnsAction', () => {
    const { stack } = buildStack();
    const template = Template.fromStack(stack);
    const alarms = template.findResources('AWS::CloudWatch::Alarm');
    expect(Object.keys(alarms)).toHaveLength(4);
    for (const alarm of Object.values(alarms)) {
      const actions = alarm.Properties.AlarmActions as Array<{ Ref?: string }>;
      expect(actions.length).toBeGreaterThan(0);
      const refs = actions.map((a) => a.Ref ?? '');
      expect(refs.some((r) => r.includes('AlertTopic'))).toBe(true);
    }
  });

  it('creates Dashboard with name GarageOS-Production', () => {
    const { stack } = buildStack();
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::CloudWatch::Dashboard', {
      DashboardName: 'GarageOS-Production',
    });
  });

  it('Dashboard body contains 4 widget sections in expected order', () => {
    const { stack } = buildStack();
    const template = Template.fromStack(stack);
    const dashboards = template.findResources('AWS::CloudWatch::Dashboard');
    // CDK serializes DashboardBody via stack.toJsonString() which always
    // produces a Fn::Join (CDK embeds {"Ref":"AWS::Region"} per widget).
    // Reconstruct parseable JSON by substituting token objects with a
    // placeholder string so JSON.parse succeeds.
    const rawBody = Object.values(dashboards)[0]!.Properties.DashboardBody as
      | string
      | { 'Fn::Join': [string, Array<string | object>] };
    let bodyJson: string;
    if (typeof rawBody === 'string') {
      bodyJson = rawBody;
    } else {
      // Fn::Join reconstruction depends on CDK's current dashboard-body splitting
      // strategy (interleaved string parts + Ref tokens). May need revisit on CDK
      // upgrades that switch to Fn::Sub or change the quote placement.
      const parts = rawBody['Fn::Join'][1];
      // Non-string parts are CFN tokens (e.g. {"Ref":"AWS::Region"}).
      // The surrounding quotes are already in the adjacent string parts,
      // so replace token objects with a bare word (no extra quotes).
      bodyJson = parts.map((p) => (typeof p === 'string' ? p : 'placeholder')).join('');
    }
    const body = JSON.parse(bodyJson) as {
      widgets: Array<{ properties: { title: string } }>;
    };
    expect(body.widgets).toHaveLength(4);
    const titles = body.widgets.map((w) => w.properties.title);
    expect(titles).toEqual([
      'API Requests (Invocations)',
      'Lambda Duration',
      'API Gateway Errors',
      'Lambda Concurrency & Throttles',
    ]);
  });
});
