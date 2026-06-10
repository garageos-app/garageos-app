import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import { Construct } from 'constructs';

// EventBridge Scheduler infrastructure for GarageOS:
//   1. ScheduleGroup `garageos-deadlines` — landing zone for runtime-created
//      deadline schedules (BR-064 revision email, BR-066 cancel email, etc.).
//      Empty at deploy time; populated by H3 deadline reminders PR via
//      SchedulerClient SDK calls from app code.
//   2. SchedulerRole — assumed by scheduler.amazonaws.com. Two inline
//      policies: InvokeHTTPEndpoint (HTTP callbacks) and Lambda invoke
//      (warming + direct-Lambda schedules for deadline reminders).
//      Note: G2 shipped a third policy (secretsmanager:GetSecretValue for HMAC
//      signing) that was removed in H3 cleanup after the Lambda direct invoke
//      pivot (feedback_eventbridge_scheduler_static_http_params.md).
//   3. WarmingSchedule — singleton CfnSchedule firing every 5 min
//      Mon-Sat 08:00-20:00 Europe/Rome. Target: Lambda with payload
//      {source: 'warming'}. Reduces p99 cold-start tail. ~3500 invocations
//      per month (well within free tier).

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
  readonly warmingEnabled: boolean;
  readonly warmingScheduleName: string;
  readonly deadlineGroupName: string;
}

export class SchedulerConstruct extends Construct {
  public readonly schedulerRole: iam.Role;
  public readonly scheduleGroup: scheduler.CfnScheduleGroup;
  public readonly warmingSchedule: scheduler.CfnSchedule;
  public readonly transferExpirySchedule: scheduler.CfnSchedule;
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

    // Daily housekeeping sweep that flips expired pending transfers to
    // 'expired' (F-CLI-401 PR3, BR-043). Recurring singleton mirroring
    // WarmingSchedule — NOT the per-row one-shot pattern used for deadline
    // reminders. Lives in the 'default' group; the garageos-deadlines group
    // stays reserved for runtime-created deadline schedules. Gated by the same
    // warmingEnabled env flag (the single "schedules active in this env"
    // switch). UTC (not Europe/Rome) — it is timezone-indifferent night work
    // and UTC avoids DST edge cases. Retries are safe because the sweep is
    // idempotent (the status IN (pending_*) predicate no-ops on re-run).
    this.transferExpirySchedule = new scheduler.CfnSchedule(this, 'TransferExpirySchedule', {
      name: 'garageos-transfer-expiry',
      groupName: 'default',
      description: 'Daily sweep: expire pending vehicle transfers past their 7-day window (BR-043)',
      state: props.warmingEnabled ? 'ENABLED' : 'DISABLED',
      scheduleExpression: 'cron(0 3 * * ? *)',
      scheduleExpressionTimezone: 'UTC',
      flexibleTimeWindow: { mode: 'OFF' },
      target: {
        arn: props.lambdaFunction.functionArn,
        roleArn: this.schedulerRole.roleArn,
        input: JSON.stringify({ source: 'transfer-expiry' }),
        retryPolicy: {
          maximumRetryAttempts: 2,
        },
      },
    });
  }
}
