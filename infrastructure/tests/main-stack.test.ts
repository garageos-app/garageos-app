import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { ApiGatewayConstruct } from '../lib/constructs/api-gateway.js';
import { CognitoConstruct } from '../lib/constructs/cognito.js';
import { DnsConstruct } from '../lib/constructs/dns.js';
import { LambdaApiConstruct } from '../lib/constructs/lambda-api.js';
import { SecretsConstruct } from '../lib/constructs/secrets.js';
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
  new LambdaApiConstruct(stack, 'LambdaApi', {
    memoryMb: 1024,
    architecture: 'arm64',
    timeoutSec: 30,
    reservedConcurrency: 100,
    logRetentionDays: 7,
    appSecret: secrets.appSecret,
    officineUserPoolArn: cognito.officineUserPool.userPoolArn,
    clientiUserPoolArn: cognito.clientiUserPool.userPoolArn,
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

  it('Lambda includes the LWA arm64 layer', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Layers: Match.arrayWith([Match.stringLikeRegexp('LambdaAdapterLayerArm64')]),
    });
  });

  it('Lambda env wires LWA + APP_SECRETS_ARN', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          NODE_ENV: 'production',
          AWS_LWA_PORT: '8080',
          AWS_LWA_READINESS_CHECK_PATH: '/health',
          AWS_LWA_ASYNC_INIT: 'true',
          APP_SECRETS_ARN: Match.anyValue(),
        }),
      },
    });
  });

  it('execution role has secretsmanager:GetSecretValue and the 4 cognito-idp:Admin* actions, but NO s3 actions', () => {
    // Find the inline policy attached to the execution role and check
    // its statements. Presence: secretsmanager:GetSecretValue +
    // 4 cognito-idp Admin/List actions. Absence: s3:* (deferred to PR 23).
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
    expect(allActions.some((a) => a.startsWith('s3:'))).toBe(false);
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
    const lambdaApi = new LambdaApiConstruct(stack, 'LambdaApi', {
      memoryMb: 1024,
      architecture: 'arm64',
      timeoutSec: 30,
      reservedConcurrency: 100,
      logRetentionDays: 7,
      appSecret: secrets.appSecret,
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

  it('exposes ApiUrl, HttpApiEndpoint, LambdaFunctionArn, AppSecretsArn outputs', () => {
    template.hasOutput('ApiUrl', {});
    template.hasOutput('HttpApiEndpoint', {});
    template.hasOutput('LambdaFunctionArn', {});
    template.hasOutput('AppSecretsArn', {});
  });

  it('combined resource counts match scope', () => {
    template.resourceCountIs('AWS::Lambda::Function', 1);
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    template.resourceCountIs('AWS::ApiGatewayV2::DomainName', 1);
    template.resourceCountIs('AWS::SecretsManager::Secret', 1);
    template.resourceCountIs('AWS::CertificateManager::Certificate', 1);
    template.resourceCountIs('AWS::Route53::RecordSet', 1);
    // No Cognito, no S3, no WAF in PR 21.
    template.resourceCountIs('AWS::Cognito::UserPool', 0);
    template.resourceCountIs('AWS::S3::Bucket', 0);
    template.resourceCountIs('AWS::WAFv2::WebACL', 0);
  });
});
