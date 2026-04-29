import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

import { ApiGatewayConstruct } from '../constructs/api-gateway.js';
import { CognitoConstruct } from '../constructs/cognito.js';
import { DnsConstruct } from '../constructs/dns.js';
import { LambdaApiConstruct } from '../constructs/lambda-api.js';
import { SecretsConstruct } from '../constructs/secrets.js';
import { type EnvironmentConfig } from '../config/production.js';

// Single production stack hosting the five constructs shipped through
// PR 22 (DNS, Secrets, Cognito, Lambda API, API Gateway). Subsequent
// PRs add Storage+WAF (PR 23), SES+Scheduler+Monitoring (PR 24).
// Stack-split (NetworkStack + ComputeStack) deferred until rollback
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

    const lambdaApi = new LambdaApiConstruct(this, 'LambdaApi', {
      memoryMb: config.lambda.memoryMb,
      architecture: config.lambda.architecture,
      timeoutSec: config.lambda.timeoutSec,
      reservedConcurrency: config.lambda.reservedConcurrency,
      logRetentionDays: config.logRetentionDays,
      appSecret: secrets.appSecret,
      officineUserPoolArn: cognito.officineUserPool.userPoolArn,
      clientiUserPoolArn: cognito.clientiUserPool.userPoolArn,
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
  }
}
