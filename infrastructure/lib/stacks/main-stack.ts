import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

import { ApiGatewayConstruct } from '../constructs/api-gateway.js';
import { CognitoConstruct } from '../constructs/cognito.js';
import { DnsConstruct } from '../constructs/dns.js';
import { LambdaApiConstruct } from '../constructs/lambda-api.js';
import { SecretsConstruct } from '../constructs/secrets.js';
import { SesConstruct } from '../constructs/ses.js';
import { StorageConstruct } from '../constructs/storage.js';
import { type EnvironmentConfig } from '../config/production.js';

// Single production stack hosting the six constructs shipped through
// PR 23 (DNS, Secrets, Cognito, Storage, Lambda API, API Gateway).
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
      attachmentsBucket: storage.attachmentsBucket,
      sesIdentityArn: sesConstruct.identityArn,
      sesConfigurationSetArn: sesConstruct.configurationSetArn,
      sesFromAddress: config.emailFromAddress,
      sesConfigurationSetName: config.sesConfigurationSetName,
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
    new cdk.CfnOutput(this, 'SesEmailIdentityArn', {
      value: sesConstruct.identityArn,
      description:
        'SES domain identity (verify on AWS console post-deploy; DKIM CNAMEs propagate 5-15 min)',
    });
    new cdk.CfnOutput(this, 'SesConfigurationSetName', {
      value: sesConstruct.configurationSet.configurationSetName,
    });
  }
}
