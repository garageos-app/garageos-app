import * as cdk from 'aws-cdk-lib';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';

import { ApiGatewayConstruct } from '../constructs/api-gateway.js';
import { CognitoConstruct } from '../constructs/cognito.js';
import { DnsConstruct } from '../constructs/dns.js';
import { LambdaApiConstruct } from '../constructs/lambda-api.js';
import { SecretsConstruct } from '../constructs/secrets.js';
import { StorageConstruct } from '../constructs/storage.js';
import { WafConstruct } from '../constructs/waf.js';
import { type EnvironmentConfig } from '../config/production.js';

// Single production stack hosting the seven constructs shipped through
// PR 23 (DNS, Secrets, Cognito, Storage, Lambda API, API Gateway, WAF).
// Subsequent PRs add SES+Scheduler+Monitoring (PR 24), web app static
// + CloudFront + Cognito Hosted UI (PR 25). Stack-split (NetworkStack +
// ComputeStack) deferred until rollback granularity matters — currently
// tutto-monolitico.

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

    // WAF + association DOPO ApiGateway perché serve lo stage ARN.
    // Stage ARN format AWS-side richiesto da WAFv2:
    //   arn:<partition>:apigateway:<region>::/apis/<apiId>/stages/<stageName>
    // Nota il LEADING SLASH prima di `apis` — caratteristica degli AWS service
    // ARN senza account section. cdk.Stack.formatArn() non produce questo
    // leading slash quando `account: ''` + `resource: 'apis'` (genera
    // `::apis/...` invece di `::/apis/...`), quindi WAF rejecta con
    // "ARN isn't valid". Workaround: building string direttamente con
    // cdk.Aws.PARTITION/REGION (token-safe).
    const waf = new WafConstruct(this, 'Waf', {
      environment: config.environment,
      ipRequestRateLimit: config.waf.ipRequestRateLimit,
    });

    const stageArn = `arn:${cdk.Aws.PARTITION}:apigateway:${cdk.Aws.REGION}::/apis/${apiGateway.httpApi.apiId}/stages/${apiGateway.defaultStage.stageName}`;

    new wafv2.CfnWebACLAssociation(this, 'WafApiAssociation', {
      resourceArn: stageArn,
      webAclArn: waf.webAcl.attrArn,
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
    new cdk.CfnOutput(this, 'WafWebAclArn', {
      value: waf.webAcl.attrArn,
      description: 'WAFv2 Web ACL ARN attached to API Gateway HTTP API v2 default stage',
    });
  }
}
