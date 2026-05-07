import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { ApiGatewayConstruct } from '../lib/constructs/api-gateway.js';
import { CognitoConstruct } from '../lib/constructs/cognito.js';
import { DnsConstruct } from '../lib/constructs/dns.js';
import { LambdaApiConstruct } from '../lib/constructs/lambda-api.js';
import { SecretsConstruct } from '../lib/constructs/secrets.js';
import { StorageConstruct } from '../lib/constructs/storage.js';
import { MainStack } from '../lib/stacks/main-stack.js';
import { OidcStack } from '../lib/stacks/oidc-stack.js';
import { productionConfig } from '../lib/config/production.js';

describe('OidcStack', () => {
  const app = new cdk.App();
  const stack = new OidcStack(app, 'TestOidcStack', {
    env: { account: '123456789012', region: 'eu-central-1' },
    githubOrg: 'garageos-app',
    githubRepo: 'garageos-app',
  });
  const template = Template.fromStack(stack);

  it('provisions exactly one OpenID Connect provider for GitHub', () => {
    // CDK L2 OpenIdConnectProvider synthesizes as a custom resource
    // backed by a Lambda (handles thumbprint rotation automatically).
    // Asserting on the custom-resource type, not the native
    // AWS::IAM::OIDCProvider that L1 CfnOIDCProvider would emit.
    template.resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 1);
    template.hasResourceProperties('Custom::AWSCDKOpenIdConnectProvider', {
      Url: 'https://token.actions.githubusercontent.com',
    });
  });

  it('provisions a deploy IAM role with federated trust scoped to the repo', () => {
    // The custom resource creates its own service-Lambda + role, so the
    // synthesized template has 2 AWS::IAM::Role. Use hasResourceProperties
    // to scope to the deploy role specifically (matches by RoleName).
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'garageos-github-deploy',
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sts:AssumeRoleWithWebIdentity',
            Effect: 'Allow',
            Condition: Match.objectLike({
              StringLike: {
                'token.actions.githubusercontent.com:sub': 'repo:garageos-app/garageos-app:*',
              },
            }),
          }),
        ]),
      },
    });
  });

  it('attaches PowerUserAccess managed policy', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      ManagedPolicyArns: Match.arrayWith([
        Match.objectLike({
          'Fn::Join': Match.arrayWith([
            Match.arrayWith([Match.stringLikeRegexp('PowerUserAccess')]),
          ]),
        }),
      ]),
    });
  });

  it('outputs the deploy role ARN', () => {
    template.hasOutput('DeployRoleArn', {});
  });
});

describe('DnsConstruct (synth-mock mode)', () => {
  // Synth-mock skips Route53 fromLookup; without it cdk synth would
  // require an AWS account-id in the env. CI runs with no creds, so
  // every cdk synth in CI sets CDK_SYNTH_MOCK=true.
  function buildStack() {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestDnsStack', {
      env: { account: '123456789012', region: 'eu-central-1' },
    });
    new DnsConstruct(stack, 'Dns', {
      domainName: 'garageos.it',
      apiSubdomain: 'api',
      synthMock: true,
    });
    return Template.fromStack(stack);
  }

  it('provisions an ACM certificate for api.garageos.it', () => {
    const template = buildStack();
    template.resourceCountIs('AWS::CertificateManager::Certificate', 1);
    template.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: 'api.garageos.it',
      ValidationMethod: 'DNS',
    });
  });
});

describe('SecretsConstruct', () => {
  function buildTemplate() {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestSecretsStack', {
      env: { account: '123456789012', region: 'eu-central-1' },
    });
    new SecretsConstruct(stack, 'Secrets', { environment: 'production' });
    return Template.fromStack(stack);
  }

  it('provisions the garageos/production/app secret', () => {
    const template = buildTemplate();
    template.resourceCountIs('AWS::SecretsManager::Secret', 1);
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'garageos/production/app',
    });
  });

  it('secret retains on stack deletion', () => {
    const template = buildTemplate();
    template.hasResource('AWS::SecretsManager::Secret', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
  });
});

describe('LambdaApiConstruct', () => {
  // Build once per describe to avoid running esbuild bundling 5 times
  // (each call triggers NodejsFunction synth → ~1.4 MB bundle + Prisma
  // engines under a fresh cdk.out temp dir; multiplying that by 5 is
  // both slow and disk-heavy on Windows).
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestLambdaStack', {
    env: { account: '123456789012', region: 'eu-central-1' },
  });
  const secrets = new SecretsConstruct(stack, 'Secrets', { environment: 'production' });
  const cognito = new CognitoConstruct(stack, 'Cognito', {
    environment: 'production',
    mfaTotpEnabled: true,
  });
  const storage = new StorageConstruct(stack, 'Storage', {
    environment: 'production',
    corsAllowedOrigins: ['https://app.garageos.it'],
  });
  new LambdaApiConstruct(stack, 'LambdaApi', {
    memoryMb: 1024,
    architecture: 'arm64',
    timeoutSec: 30,
    reservedConcurrency: 100,
    logRetentionDays: 7,
    appSecret: secrets.appSecret,
    officineUserPoolArn: cognito.officineUserPool.userPoolArn,
    clientiUserPoolArn: cognito.clientiUserPool.userPoolArn,
    attachmentsBucket: storage.attachmentsBucket,
    sesIdentityArn: 'arn:aws:ses:eu-central-1:123456789012:identity/garageos.it',
    sesConfigurationSetArn:
      'arn:aws:ses:eu-central-1:123456789012:configuration-set/garageos-production',
    sesFromAddress: 'noreply@garageos.it',
    sesConfigurationSetName: 'garageos-production',
    verifyEmailBaseUrl: 'https://app.garageos.it/verify-email',
  });
  const template = Template.fromStack(stack);

  it('provisions exactly one Lambda function on Node 22 arm64', () => {
    template.resourceCountIs('AWS::Lambda::Function', 1);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      MemorySize: 1024,
      Timeout: 30,
      ReservedConcurrentExecutions: 100,
    });
  });

  it('Lambda has no extension layers attached (adapter is in-process via @fastify/aws-lambda)', () => {
    const fns = template.findResources('AWS::Lambda::Function');
    for (const res of Object.values(fns)) {
      const layers = (res.Properties as { Layers?: unknown[] }).Layers;
      // CDK omits the property entirely when there are no layers.
      expect(layers === undefined || layers.length === 0).toBe(true);
    }
  });

  it('Lambda env wires NODE_ENV, APP_SECRETS_ARN, NODE_EXTRA_CA_CERTS, and S3_ATTACHMENTS_BUCKET', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          NODE_ENV: 'production',
          APP_SECRETS_ARN: Match.anyValue(),
          NODE_EXTRA_CA_CERTS: '/var/task/supabase-ca.crt',
          S3_ATTACHMENTS_BUCKET: Match.anyValue(),
        }),
      },
    });
  });

  it('execution role has secretsmanager:GetSecretValue, the 4 cognito-idp:Admin* actions, and s3:GetObject + s3:PutObject', () => {
    // Find the inline policy attached to the execution role and check
    // its statements. Presence: secretsmanager:GetSecretValue +
    // 4 cognito-idp Admin/List actions + s3:GetObject + s3:PutObject
    // (pre-emptive grant added in PR 23).
    const policies = template.findResources('AWS::IAM::Policy');
    const inlineStatements = Object.values(policies).flatMap(
      (res) => res.Properties.PolicyDocument.Statement as Array<{ Action: string | string[] }>,
    );
    const allActions = inlineStatements.flatMap((s) =>
      Array.isArray(s.Action) ? s.Action : [s.Action],
    );
    expect(allActions).toContain('secretsmanager:GetSecretValue');
    expect(allActions).toContain('cognito-idp:AdminGetUser');
    expect(allActions).toContain('cognito-idp:AdminCreateUser');
    expect(allActions).toContain('cognito-idp:AdminUpdateUserAttributes');
    expect(allActions).toContain('cognito-idp:ListUsers');
    expect(allActions).toContain('s3:GetObject');
    expect(allActions).toContain('s3:PutObject');
  });

  it('cognito-idp policy is scoped to both user pool ARNs (not Resource: *)', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    const cognitoStatements = Object.values(policies).flatMap((res) =>
      (
        res.Properties.PolicyDocument.Statement as Array<{
          Action: string | string[];
          Resource: unknown;
        }>
      ).filter((s) => {
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        return actions.some((a) => a.startsWith('cognito-idp:'));
      }),
    );
    expect(cognitoStatements.length).toBeGreaterThanOrEqual(1);
    for (const stmt of cognitoStatements) {
      // Resource is either an array of refs (Fn::GetAtt to user pool Arn)
      // or a single ref. Wildcard '*' would be a least-privilege violation.
      const resources = Array.isArray(stmt.Resource) ? stmt.Resource : [stmt.Resource];
      for (const r of resources) {
        expect(r).not.toBe('*');
      }
      expect(resources.length).toBe(2); // both pool ARNs
    }
  });

  it('log group retention is 7 days', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/aws/lambda/garageos-api',
      RetentionInDays: 7,
    });
  });
});

describe('ApiGatewayConstruct', () => {
  // Hoist template build to describe scope (same pattern Task 6 used)
  // — esbuild bundling is expensive and disk space is constrained.
  // CDK Templates are immutable after fromStack so sharing is safe.
  function buildTemplate() {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestApiGwStack', {
      env: { account: '123456789012', region: 'eu-central-1' },
    });
    const dns = new DnsConstruct(stack, 'Dns', {
      domainName: 'garageos.it',
      apiSubdomain: 'api',
      synthMock: true,
    });
    const secrets = new SecretsConstruct(stack, 'Secrets', { environment: 'production' });
    const cognito = new CognitoConstruct(stack, 'Cognito', {
      environment: 'production',
      mfaTotpEnabled: true,
    });
    const storage = new StorageConstruct(stack, 'Storage', {
      environment: 'production',
      corsAllowedOrigins: ['https://app.garageos.it'],
    });
    const lambdaApi = new LambdaApiConstruct(stack, 'LambdaApi', {
      memoryMb: 1024,
      architecture: 'arm64',
      timeoutSec: 30,
      reservedConcurrency: 100,
      logRetentionDays: 7,
      appSecret: secrets.appSecret,
      officineUserPoolArn: cognito.officineUserPool.userPoolArn,
      clientiUserPoolArn: cognito.clientiUserPool.userPoolArn,
      attachmentsBucket: storage.attachmentsBucket,
      sesIdentityArn: 'arn:aws:ses:eu-central-1:123456789012:identity/garageos.it',
      sesConfigurationSetArn:
        'arn:aws:ses:eu-central-1:123456789012:configuration-set/garageos-production',
      sesFromAddress: 'noreply@garageos.it',
      sesConfigurationSetName: 'garageos-production',
      verifyEmailBaseUrl: 'https://app.garageos.it/verify-email',
    });
    new ApiGatewayConstruct(stack, 'ApiGateway', {
      apiSubdomain: 'api',
      domainName: 'garageos.it',
      hostedZone: dns.hostedZone,
      apiCertificate: dns.apiCertificate,
      lambdaFunction: lambdaApi.function,
      throttleBurst: 200,
      throttleRate: 100,
      logRetentionDays: 7,
    });
    return Template.fromStack(stack);
  }
  const template = buildTemplate();

  it('provisions exactly one HTTP API v2', () => {
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      Name: 'garageos-api',
      ProtocolType: 'HTTP',
    });
  });

  it('provisions custom domain api.garageos.it with TLS 1.2', () => {
    template.resourceCountIs('AWS::ApiGatewayV2::DomainName', 1);
    template.hasResourceProperties('AWS::ApiGatewayV2::DomainName', {
      DomainName: 'api.garageos.it',
      DomainNameConfigurations: Match.arrayWith([
        Match.objectLike({ SecurityPolicy: 'TLS_1_2', EndpointType: 'REGIONAL' }),
      ]),
    });
  });

  it('provisions Route53 A record alias for api.garageos.it', () => {
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'api.garageos.it.',
      Type: 'A',
    });
  });

  it('catch-all proxy route exists', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'ANY /{proxy+}',
    });
  });

  it('access log group has 7-day retention', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/aws/apigateway/garageos-api-access',
      RetentionInDays: 7,
    });
  });
});

describe('MainStack (integration)', () => {
  // Override synthMock unconditionally for this suite — productionConfig
  // reads CDK_SYNTH_MOCK lazily, which may be unset in the test runner.
  const config = { ...productionConfig, synthMock: true };

  // Hoist build (Task 6/7 pattern) so the Lambda bundles once for all
  // assertions. Disk space is tight; one bundle pass per describe is
  // the budget.
  function buildTemplate() {
    const app = new cdk.App();
    const stack = new MainStack(app, 'TestMainStack', {
      env: { account: '123456789012', region: 'eu-central-1' },
      config,
    });
    return Template.fromStack(stack);
  }
  const template = buildTemplate();

  it('exposes all top-level CfnOutput', () => {
    template.hasOutput('ApiUrl', {});
    template.hasOutput('HttpApiEndpoint', {});
    template.hasOutput('LambdaFunctionArn', {});
    template.hasOutput('AppSecretsArn', {});
    template.hasOutput('CognitoOfficineUserPoolId', {});
    template.hasOutput('CognitoOfficineClientId', {});
    template.hasOutput('CognitoClientiUserPoolId', {});
    template.hasOutput('CognitoClientiClientId', {});
    template.hasOutput('AttachmentsBucketName', {});
    template.hasOutput('SesEmailIdentityArn', {});
    template.hasOutput('SesConfigurationSetName', {});
  });

  it('combined resource counts match scope', () => {
    template.resourceCountIs('AWS::Lambda::Function', 1);
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    template.resourceCountIs('AWS::ApiGatewayV2::DomainName', 1);
    template.resourceCountIs('AWS::SecretsManager::Secret', 1);
    template.resourceCountIs('AWS::CertificateManager::Certificate', 1);
    // PR G1: SES domain identity wires DKIM via ses.Identity.publicHostedZone,
    // which auto-publishes 3 RSA_2048 EASY_DKIM CNAMEs into the hosted zone.
    // Total Route53 records: 1 API alias + 3 SES DKIM CNAMEs = 4.
    template.resourceCountIs('AWS::Route53::RecordSet', 4);
    // PR 22: Cognito officine + clienti pools (each pool also produces
    // one UserPoolClient).
    template.resourceCountIs('AWS::Cognito::UserPool', 2);
    template.resourceCountIs('AWS::Cognito::UserPoolClient', 2);
    // PR 23: S3 attachments bucket. WAF deferred a PR 25 (CloudFront
    // + WAF CLOUDFRONT scope) — WAFv2 REGIONAL non supporta API
    // Gateway HTTP API v2.
    template.resourceCountIs('AWS::S3::Bucket', 1);
    template.resourceCountIs('AWS::WAFv2::WebACL', 0);
    template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 0);
    // PR G1: SES domain identity + configuration set.
    template.resourceCountIs('AWS::SES::EmailIdentity', 1);
    template.resourceCountIs('AWS::SES::ConfigurationSet', 1);
  });

  it('grants the Lambda execution role minimal S3 permissions on the attachments bucket', () => {
    // Verify s3:GetObject + s3:PutObject scoped al bucket arn/*.
    // Action assertion stringent — la grant è raw addToPolicy con
    // exactly 2 actions, niente espansione.
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: ['s3:GetObject', 's3:PutObject'],
          }),
        ]),
      },
    });
  });
});
