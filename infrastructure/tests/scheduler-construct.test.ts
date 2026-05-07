import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { SchedulerConstruct } from '../lib/constructs/scheduler.js';

// Helper builds a fresh stack per test. Uses Lambda.fromFunctionArn (static
// factory returning IFunction) and Secret.fromSecretCompleteArn so the
// SchedulerConstruct gets real-shape props without provisioning a real
// Lambda or Secret in the test stack (avoids esbuild bundling cost).
function buildStack(opts: { warmingEnabled?: boolean } = {}) {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack', {
    env: { account: '111122223333', region: 'eu-central-1' },
  });
  const lambdaFunction = lambda.Function.fromFunctionArn(
    stack,
    'MockLambda',
    'arn:aws:lambda:eu-central-1:111122223333:function:garageos-api',
  );
  const hmacSecret = secretsmanager.Secret.fromSecretCompleteArn(
    stack,
    'MockSecret',
    'arn:aws:secretsmanager:eu-central-1:111122223333:secret:garageos/production/eventbridge-hmac-AbCdEf',
  );
  const construct = new SchedulerConstruct(stack, 'Scheduler', {
    lambdaFunction,
    hmacSecret,
    warmingEnabled: opts.warmingEnabled ?? true,
    warmingScheduleName: 'garageos-api-warming',
    deadlineGroupName: 'garageos-deadlines',
  });
  return { stack, construct };
}

describe('SchedulerConstruct', () => {
  it('creates a CfnScheduleGroup named garageos-deadlines', () => {
    const { stack } = buildStack();
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Scheduler::ScheduleGroup', {
      Name: 'garageos-deadlines',
    });
  });

  it('creates a SchedulerRole assumed by scheduler.amazonaws.com', () => {
    const { stack } = buildStack();
    const template = Template.fromStack(stack);
    template.hasResourceProperties(
      'AWS::IAM::Role',
      Match.objectLike({
        AssumeRolePolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Allow',
              Principal: { Service: 'scheduler.amazonaws.com' },
              Action: 'sts:AssumeRole',
            }),
          ]),
        }),
      }),
    );
  });

  it('SchedulerRole has scheduler:InvokeHTTPEndpoint policy on *', () => {
    const { stack } = buildStack();
    const template = Template.fromStack(stack);
    const policies = template.findResources('AWS::IAM::Role');
    const schedulerRole = Object.values(policies).find((r) =>
      JSON.stringify(r.Properties.AssumeRolePolicyDocument).includes('scheduler.amazonaws.com'),
    );
    expect(schedulerRole).toBeDefined();
    const inlinePolicies = schedulerRole!.Properties.Policies as Array<{
      PolicyDocument: {
        Statement: Array<{ Action: string | string[]; Resource: string | string[] }>;
      };
    }>;
    const allStatements = inlinePolicies.flatMap((p) => p.PolicyDocument.Statement);
    const httpStmt = allStatements.find((s) =>
      Array.isArray(s.Action)
        ? s.Action.includes('scheduler:InvokeHTTPEndpoint')
        : s.Action === 'scheduler:InvokeHTTPEndpoint',
    );
    expect(httpStmt).toBeDefined();
    expect(httpStmt!.Resource).toBe('*');
  });

  it('SchedulerRole has secretsmanager:GetSecretValue scoped to hmacSecret arn', () => {
    const { stack } = buildStack();
    const template = Template.fromStack(stack);
    const policies = template.findResources('AWS::IAM::Role');
    const schedulerRole = Object.values(policies).find((r) =>
      JSON.stringify(r.Properties.AssumeRolePolicyDocument).includes('scheduler.amazonaws.com'),
    );
    const inlinePolicies = schedulerRole!.Properties.Policies as Array<{
      PolicyDocument: {
        Statement: Array<{ Action: string | string[]; Resource: string | string[] }>;
      };
    }>;
    const allStatements = inlinePolicies.flatMap((p) => p.PolicyDocument.Statement);
    const secretStmt = allStatements.find((s) =>
      Array.isArray(s.Action)
        ? s.Action.includes('secretsmanager:GetSecretValue')
        : s.Action === 'secretsmanager:GetSecretValue',
    );
    expect(secretStmt).toBeDefined();
    expect(JSON.stringify(secretStmt!.Resource)).toContain('eventbridge-hmac');
  });

  it('SchedulerRole has lambda:InvokeFunction scoped to lambdaFunction arn', () => {
    const { stack } = buildStack();
    const template = Template.fromStack(stack);
    const policies = template.findResources('AWS::IAM::Role');
    const schedulerRole = Object.values(policies).find((r) =>
      JSON.stringify(r.Properties.AssumeRolePolicyDocument).includes('scheduler.amazonaws.com'),
    );
    const inlinePolicies = schedulerRole!.Properties.Policies as Array<{
      PolicyDocument: {
        Statement: Array<{ Action: string | string[]; Resource: string | string[] }>;
      };
    }>;
    const allStatements = inlinePolicies.flatMap((p) => p.PolicyDocument.Statement);
    const lambdaStmt = allStatements.find((s) =>
      Array.isArray(s.Action)
        ? s.Action.includes('lambda:InvokeFunction')
        : s.Action === 'lambda:InvokeFunction',
    );
    expect(lambdaStmt).toBeDefined();
    expect(JSON.stringify(lambdaStmt!.Resource)).toContain('function:garageos-api');
  });

  it('creates CfnSchedule garageos-api-warming with cron expression and Europe/Rome timezone', () => {
    const { stack } = buildStack();
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Scheduler::Schedule', {
      Name: 'garageos-api-warming',
      GroupName: 'default',
      State: 'ENABLED',
      ScheduleExpression: 'cron(*/5 8-20 ? * MON-SAT *)',
      ScheduleExpressionTimezone: 'Europe/Rome',
      FlexibleTimeWindow: { Mode: 'OFF' },
    });
  });

  it('WarmingSchedule targets lambdaFunction with input source=warming and zero retries', () => {
    const { stack } = buildStack();
    const template = Template.fromStack(stack);
    template.hasResourceProperties(
      'AWS::Scheduler::Schedule',
      Match.objectLike({
        Name: 'garageos-api-warming',
        Target: Match.objectLike({
          Arn: 'arn:aws:lambda:eu-central-1:111122223333:function:garageos-api',
          Input: JSON.stringify({ source: 'warming' }),
          RetryPolicy: { MaximumRetryAttempts: 0 },
        }),
      }),
    );
  });

  it('warmingEnabled toggle controls Schedule.State', () => {
    const enabledStack = buildStack({ warmingEnabled: true }).stack;
    const enabledTpl = Template.fromStack(enabledStack);
    enabledTpl.hasResourceProperties('AWS::Scheduler::Schedule', { State: 'ENABLED' });

    const disabledStack = buildStack({ warmingEnabled: false }).stack;
    const disabledTpl = Template.fromStack(disabledStack);
    disabledTpl.hasResourceProperties('AWS::Scheduler::Schedule', { State: 'DISABLED' });
  });
});
