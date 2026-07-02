import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

import { ApiGatewayConstruct } from '../constructs/api-gateway.js';
import { CognitoConstruct } from '../constructs/cognito.js';
import { CognitoTriggerLambdaConstruct } from '../constructs/cognito-trigger-lambda.js';
import { DnsConstruct } from '../constructs/dns.js';
import { LAMBDA_FUNCTION_NAME, LambdaApiConstruct } from '../constructs/lambda-api.js';
import { MonitoringConstruct } from '../constructs/monitoring.js';
import { SchedulerConstruct } from '../constructs/scheduler.js';
import { SecretsConstruct } from '../constructs/secrets.js';
import { SesConstruct } from '../constructs/ses.js';
import { type EnvironmentConfig } from '../config/production.js';

// Single production stack hosting the core constructs (DNS, Secrets,
// Cognito, Lambda API, API Gateway, SES, Scheduler, Monitoring).
//
// Web hosting (S3 + CloudFront + Route53 alias for app.<domain>) lives
// in a dedicated WebStack (eu-central-1) plus a WebCertStack
// (us-east-1) for the ACM certificate — see PR demo-0. Cross-region
// reference is wired via `crossRegionReferences: true`.
//
// WAF CLOUDFRONT (us-east-1) is deferred — see
// memory/project_waf_cloudfront_deferred.md for the trigger criteria
// and the plan to add it. Current protection layer for the API:
// throttling (200 burst / 100 rate) + Lambda concurrency cap (100).
// `WafConstruct` (lib/constructs/waf.ts) stays in the codebase as
// reusable scaffolding for that future PR.
//
// Stack split (NetworkStack + ComputeStack) deferred until rollback
// granularity matters — currently tutto-monolitico.

export interface MainStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
}

export class MainStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MainStackProps) {
    super(scope, id, props);

    const { config } = props;

    const dns = new DnsConstruct(this, 'Dns', {
      domainName: config.domainName,
      apiSubdomain: config.apiSubdomain,
      synthMock: config.synthMock,
    });

    const secrets = new SecretsConstruct(this, 'Secrets', {
      environment: config.environment,
    });

    const cognitoTriggers = new CognitoTriggerLambdaConstruct(this, 'CognitoTriggers', {
      environment: config.environment,
      appSecret: secrets.appSecret,
      architecture: config.lambda.architecture,
      memoryMb: config.lambda.memoryMb,
      timeoutSec: config.lambda.timeoutSec,
      logRetentionDays: config.logRetentionDays,
    });

    const cognito = new CognitoConstruct(this, 'Cognito', {
      environment: config.environment,
      mfaTotpEnabled: config.cognito.mfaTotpEnabled,
      clientiCallbackUrls: config.cognito.clientiCallbackUrls,
      clientiLogoutUrls: config.cognito.clientiLogoutUrls,
      clientiTriggerFunction: cognitoTriggers.function,
    });

    // SES domain identity + config set + IAM grant. Operator post-merge
    // submits AWS production-access ticket (sandbox is account-level).
    const sesConstruct = new SesConstruct(this, 'Ses', {
      hostedZone: dns.hostedZone,
      emailFromDomain: config.emailFromDomain,
      configurationSetName: config.sesConfigurationSetName,
    });

    const lambdaApi = new LambdaApiConstruct(this, 'LambdaApi', {
      memoryMb: config.lambda.memoryMb,
      architecture: config.lambda.architecture,
      timeoutSec: config.lambda.timeoutSec,
      reservedConcurrency: config.lambda.reservedConcurrency,
      logRetentionDays: config.logRetentionDays,
      appSecret: secrets.appSecret,
      officineUserPoolArn: cognito.officineUserPool.userPoolArn,
      clientiUserPoolArn: cognito.clientiUserPool.userPoolArn,
      sesIdentityArn: sesConstruct.identityArn,
      sesConfigurationSetArn: sesConstruct.configurationSetArn,
      sesFromAddress: config.emailFromAddress,
      sesConfigurationSetName: config.sesConfigurationSetName,
      emailProvider: config.emailProvider,
      verifyEmailBaseUrl: `https://${config.appSubdomain}.${config.domainName}/verify-email`,
    });

    const apiGateway = new ApiGatewayConstruct(this, 'ApiGateway', {
      apiSubdomain: config.apiSubdomain,
      domainName: config.domainName,
      hostedZone: dns.hostedZone,
      apiCertificate: dns.apiCertificate,
      lambdaFunction: lambdaApi.function,
      throttleBurst: config.apiGateway.throttleBurst,
      throttleRate: config.apiGateway.throttleRate,
      logRetentionDays: config.logRetentionDays,
    });

    // EventBridge Scheduler infrastructure: warming cron + landing zone for
    // future runtime-created deadline schedules. Wires post-construction so
    // both LambdaApi and Scheduler reference each other without a cyclic
    // construct prop dependency.
    const schedulerConstruct = new SchedulerConstruct(this, 'Scheduler', {
      lambdaFunction: lambdaApi.function,
      // Plain string (matches LambdaApiConstruct's hardcoded functionName).
      // Passing the L2 token instead would re-introduce the cyclic dep
      // between SchedulerRole, LambdaFunction and the Lambda role policy.
      lambdaFunctionName: LAMBDA_FUNCTION_NAME,
      warmingEnabled: config.scheduler.warmingEnabled,
      warmingScheduleName: config.scheduler.warmingScheduleName,
      deadlineGroupName: config.scheduler.deadlineGroupName,
    });

    lambdaApi.function.addEnvironment('SCHEDULER_GROUP_NAME', schedulerConstruct.scheduleGroupName);
    lambdaApi.function.addEnvironment(
      'SCHEDULER_ROLE_ARN',
      schedulerConstruct.schedulerRole.roleArn,
    );

    lambdaApi.attachSchedulerPolicies({
      scheduleGroupName: schedulerConstruct.scheduleGroupName,
      schedulerRoleArn: schedulerConstruct.schedulerRole.roleArn,
    });

    const monitoring = new MonitoringConstruct(this, 'Monitoring', {
      lambdaFunctionName: LAMBDA_FUNCTION_NAME,
      httpApi: apiGateway.httpApi,
    });

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: `https://${config.apiSubdomain}.${config.domainName}`,
    });
    new cdk.CfnOutput(this, 'HttpApiEndpoint', {
      value: apiGateway.httpApi.apiEndpoint,
      description: 'AWS-generated execute-api endpoint (use for smoke before DNS propagation)',
    });
    new cdk.CfnOutput(this, 'LambdaFunctionArn', {
      value: lambdaApi.function.functionArn,
    });
    new cdk.CfnOutput(this, 'AppSecretsArn', {
      value: secrets.appSecret.secretArn,
      description:
        'Pass to `aws secretsmanager update-secret --secret-id` to populate runtime credentials',
    });
    new cdk.CfnOutput(this, 'CognitoOfficineUserPoolId', {
      value: cognito.officineUserPool.userPoolId,
      description: 'Populate into garageos/production/app secret as COGNITO_OFFICINE_POOL_ID',
    });
    new cdk.CfnOutput(this, 'CognitoOfficineClientId', {
      value: cognito.officineClient.userPoolClientId,
      description: 'Populate into garageos/production/app secret as COGNITO_OFFICINE_CLIENT_ID',
    });
    new cdk.CfnOutput(this, 'CognitoClientiUserPoolId', {
      value: cognito.clientiUserPool.userPoolId,
      description: 'Populate into garageos/production/app secret as COGNITO_CLIENTI_POOL_ID',
    });
    new cdk.CfnOutput(this, 'CognitoClientiClientId', {
      value: cognito.clientiClient.userPoolClientId,
      description: 'Populate into garageos/production/app secret as COGNITO_CLIENTI_CLIENT_ID',
    });
    new cdk.CfnOutput(this, 'CognitoPlatformAdminsUserPoolId', {
      value: cognito.platformAdminsUserPool.userPoolId,
      description:
        'Populate into garageos/production/app secret as COGNITO_PLATFORM_ADMINS_POOL_ID',
    });
    new cdk.CfnOutput(this, 'CognitoPlatformAdminsClientId', {
      value: cognito.platformAdminsClient.userPoolClientId,
      description:
        'Populate into garageos/production/app secret as COGNITO_PLATFORM_ADMINS_CLIENT_ID',
    });
    new cdk.CfnOutput(this, 'CognitoClientiHostedUiDomain', {
      value: `https://${config.cognito.clientiHostedUiDomainPrefix}.auth.${this.region}.amazoncognito.com`,
      description: 'Hosted UI base URL — feed into mobile EXPO_PUBLIC_COGNITO_HOSTED_UI (PR 3)',
    });
    new cdk.CfnOutput(this, 'SesEmailIdentityArn', {
      value: sesConstruct.identityArn,
      description:
        'SES domain identity (verify on AWS console post-deploy; DKIM CNAMEs propagate 5-15 min)',
    });
    new cdk.CfnOutput(this, 'SesConfigurationSetName', {
      value: sesConstruct.configurationSet.configurationSetName,
    });
    new cdk.CfnOutput(this, 'SchedulerWarmingScheduleName', {
      value: schedulerConstruct.warmingSchedule.name!,
      description: 'EventBridge Scheduler warming cron schedule name (verify F14.1 runbook)',
    });
    new cdk.CfnOutput(this, 'SchedulerDeadlineGroupName', {
      value: schedulerConstruct.scheduleGroupName,
      description: 'EventBridge Scheduler group reserved for runtime-created deadline schedules',
    });
    new cdk.CfnOutput(this, 'MonitoringAlertTopicArn', {
      value: monitoring.alertTopic.topicArn,
      description:
        'SNS AlertTopic ARN — operator subscribes email post-deploy via aws sns subscribe (F15.1)',
    });
    new cdk.CfnOutput(this, 'MonitoringDashboardUrl', {
      value: `https://eu-central-1.console.aws.amazon.com/cloudwatch/home?region=eu-central-1#dashboards:name=${monitoring.dashboard.dashboardName}`,
      description: 'CloudWatch dashboard URL (F15.4 verify post-deploy)',
    });
  }
}
