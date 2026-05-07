import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

// EventBridge Scheduler infrastructure for GarageOS:
//   1. ScheduleGroup `garageos-deadlines` — landing zone for runtime-created
//      deadline schedules (BR-064 revision email, BR-066 cancel email, etc.).
//      Empty at deploy time; populated by future H notifications PR via
//      SchedulerClient SDK calls from app code.
//   2. SchedulerRole — assumed by scheduler.amazonaws.com. Three inline
//      policies: InvokeHTTPEndpoint (HTTP callbacks for deadlines), secret
//      read (HMAC sign), Lambda invoke (warming + future direct-Lambda
//      schedules).
//   3. WarmingSchedule — singleton CfnSchedule firing every 5 min
//      Mon-Sat 08:00-20:00 Europe/Rome. Target: Lambda with payload
//      {source: 'warming'}. Reduces p99 cold-start tail. ~3500 invocations
//      per month (well within free tier).
//
// Out of scope for G2 (deferred to H notifications PR):
//   - HMAC sign+verify Fastify middleware
//   - POST /v1/internal/deadline-fire HTTP endpoint
//   - SchedulerClient SDK wrapper (lib/scheduler.ts) in packages/api
//   - DB table tracking runtime-created schedule ARNs
//   - CloudWatch alarms on warming failure rate (G3 Monitoring concern)

export interface SchedulerConstructProps {
  readonly lambdaFunction: lambda.IFunction;
  /**
   * Plain (non-token) function name used to build the Lambda ARN inside the
   * SchedulerRole's InvokeLambda inline policy. Passing the raw string
   * (rather than reading lambdaFunction.functionName, which is a CDK Ref
   * token) breaks an otherwise unavoidable dependency cycle:
   * LambdaRolePolicy -> SchedulerRole -> LambdaFunction -> LambdaRolePolicy
   * created by attachSchedulerPolicies' iam:PassRole grant.
   */
  readonly lambdaFunctionName: string;
  readonly hmacSecret: secretsmanager.ISecret;
  readonly warmingEnabled: boolean;
  readonly warmingScheduleName: string;
  readonly deadlineGroupName: string;
}

export class SchedulerConstruct extends Construct {
  public readonly schedulerRole: iam.Role;
  public readonly scheduleGroup: scheduler.CfnScheduleGroup;
  public readonly warmingSchedule: scheduler.CfnSchedule;
  public readonly scheduleGroupName: string;

  constructor(scope: Construct, id: string, props: SchedulerConstructProps) {
    super(scope, id);

    this.scheduleGroupName = props.deadlineGroupName;

    this.scheduleGroup = new scheduler.CfnScheduleGroup(this, 'DeadlineGroup', {
      name: props.deadlineGroupName,
    });

    // Build the Lambda ARN by hand (function name is fixed: 'garageos-api')
    // instead of referencing props.lambdaFunction.functionArn. Using the L2
    // token would create a SchedulerRole -> LambdaFunction CFN dependency,
    // which combined with attachSchedulerPolicies (Lambda role policy ->
    // SchedulerRole via iam:PassRole) and Lambda -> LambdaPolicy yields a
    // 3-node dependency cycle. Constructing the ARN string-side breaks the
    // SchedulerRole -> LambdaFunction edge without affecting runtime
    // behaviour: the ARN resolves identically.
    const stack = cdk.Stack.of(this);
    const lambdaArn = `arn:${cdk.Aws.PARTITION}:lambda:${stack.region}:${stack.account}:function:${props.lambdaFunctionName}`;

    this.schedulerRole = new iam.Role(this, 'SchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      inlinePolicies: {
        InvokeHttp: new iam.PolicyDocument({
          statements: [
            // HTTP callback target ARNs are unknown at synth time; runtime
            // schedules will reference the API endpoint URL. AWS does not
            // support resource-scoped wildcards for InvokeHTTPEndpoint.
            new iam.PolicyStatement({
              actions: ['scheduler:InvokeHTTPEndpoint'],
              resources: ['*'],
            }),
            new iam.PolicyStatement({
              actions: ['secretsmanager:GetSecretValue'],
              resources: [props.hmacSecret.secretArn],
            }),
          ],
        }),
        InvokeLambda: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['lambda:InvokeFunction'],
              resources: [lambdaArn],
            }),
          ],
        }),
      },
    });

    // Warming singleton lives in the default group, NOT in garageos-deadlines.
    // The deadline group is reserved for app-runtime-created schedules so
    // a single get-schedule-group --name garageos-deadlines listing in the
    // operator runbook reflects only deadline-tracking work.
    this.warmingSchedule = new scheduler.CfnSchedule(this, 'WarmingSchedule', {
      name: props.warmingScheduleName,
      groupName: 'default',
      description: 'Keep Lambda warm during business hours (reduces p99 cold-start tail)',
      state: props.warmingEnabled ? 'ENABLED' : 'DISABLED',
      scheduleExpression: 'cron(*/5 8-20 ? * MON-SAT *)',
      scheduleExpressionTimezone: 'Europe/Rome',
      flexibleTimeWindow: { mode: 'OFF' },
      target: {
        arn: props.lambdaFunction.functionArn,
        roleArn: this.schedulerRole.roleArn,
        input: JSON.stringify({ source: 'warming' }),
        retryPolicy: {
          maximumRetryAttempts: 0,
        },
      },
    });
  }
}
