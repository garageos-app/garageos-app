import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

import { ApiGatewayConstruct } from '../constructs/api-gateway.js';
import { CognitoConstruct } from '../constructs/cognito.js';
import { DnsConstruct } from '../constructs/dns.js';
import { LambdaApiConstruct } from '../constructs/lambda-api.js';
import { SecretsConstruct } from '../constructs/secrets.js';
import { StorageConstruct } from '../constructs/storage.js';
import { type EnvironmentConfig } from '../config/production.js';

// Single production stack hosting the six constructs shipped through
// PR 23 (DNS, Secrets, Cognito, Storage, Lambda API, API Gateway).
// WAF deferred a PR 25 — AWS WAFv2 REGIONAL non supporta API Gateway
// HTTP API v2 (solo REST API v1, ALB, AppSync, Cognito, App Runner,
// Verified Access). Pattern AWS-recommended: CloudFront in front di
// HTTP API v2 + WAF (CLOUDFRONT scope, us-east-1) — entrambi shipped
// in PR 25. Per v1 pilota i protection layer sono API Gateway
// throttling (200 burst / 100 rate) + Lambda concurrency cap (100).
//
// `WafConstruct` resta nel codebase (`lib/constructs/waf.ts`) come
// reusable scaffolding: PR 25 lo istanzierà con `scope: 'CLOUDFRONT'`
// e cross-region us-east-1.
//
// Subsequent PRs add SES+Scheduler+Monitoring (PR 24), web app static
// + CloudFront + WAF CLOUDFRONT + Cognito Hosted UI (PR 25). Stack-
// split (NetworkStack + ComputeStack) deferred until rollback
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

    const cognito = new CognitoConstruct(this, 'Cognito', {
      environment: config.environment,
      mfaTotpEnabled: config.cognito.mfaTotpEnabled,
    });

    // Storage construct ships PRIMA del LambdaApi perché LambdaApi
    // consuma il bucket via prop (CDK dep graph order).
    const storage = new StorageConstruct(this, 'Storage', {
      environment: config.environment,
      corsAllowedOrigins: [
        `https://${config.appSubdomain}.${config.domainName}`,
        `https://${config.domainName}`,
      ],
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
      attachmentsBucket: storage.attachmentsBucket,
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
    new cdk.CfnOutput(this, 'AttachmentsBucketName', {
      value: storage.attachmentsBucket.bucketName,
      description: 'S3 bucket per allegati intervention/dispute (presigned URL upload F-OFF-305)',
    });
  }
}
