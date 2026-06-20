import * as cdk from 'aws-cdk-lib';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, it } from 'vitest';

import { CognitoTriggerLambdaConstruct } from '../lib/constructs/cognito-trigger-lambda.js';

// Build an isolated stack with a real Secret (needed so appSecret.secretArn
// resolves to a non-token string in assertions). Account+region are pinned so
// the userpool/* IAM resource ARN is deterministic.
function buildStack() {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack', {
    env: { account: '111122223333', region: 'eu-central-1' },
  });
  const appSecret = new secretsmanager.Secret(stack, 'AppSecret');
  new CognitoTriggerLambdaConstruct(stack, 'CognitoTriggerLambda', {
    environment: 'production',
    appSecret,
    architecture: 'arm64',
    memoryMb: 512,
    timeoutSec: 10,
    logRetentionDays: 30,
  });
  return { stack, appSecret };
}

describe('CognitoTriggerLambdaConstruct', () => {
  it('provisions exactly one Lambda function in the isolated stack', () => {
    const { stack } = buildStack();
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::Lambda::Function', 1);
  });

  it('Lambda has correct FunctionName, Runtime nodejs22.x, and handler index.handler', () => {
    const { stack } = buildStack();
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'garageos-cognito-clienti-triggers',
      Runtime: 'nodejs22.x',
      Handler: 'index.handler',
    });
  });

  it('Lambda environment contains NODE_EXTRA_CA_CERTS pointing to supabase-ca.crt', () => {
    const { stack } = buildStack();
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          NODE_EXTRA_CA_CERTS: '/var/task/supabase-ca.crt',
        }),
      }),
    });
  });

  it('Lambda environment contains NODE_ENV=production and APP_SECRETS_ARN', () => {
    const { stack } = buildStack();
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          NODE_ENV: 'production',
          // APP_SECRETS_ARN resolves to a CFN token — objectLike match
          // verifies the key is present without asserting the resolved value.
          APP_SECRETS_ARN: Match.anyValue(),
        }),
      }),
    });
  });

  it('Lambda environment does NOT contain a pool id (no CLIENTI_USER_POOL_ID key)', () => {
    // Guard against re-introducing the CFN dependency cycle: the trigger
    // must read event.userPoolId at runtime, not from an env var.
    const { stack } = buildStack();
    const template = Template.fromStack(stack);
    template.hasResourceProperties(
      'AWS::Lambda::Function',
      Match.not(
        Match.objectLike({
          Environment: Match.objectLike({
            Variables: Match.objectLike({
              CLIENTI_USER_POOL_ID: Match.anyValue(),
            }),
          }),
        }),
      ),
    );
  });

  it('IAM policy has the three cognito-idp trigger actions on a userpool/* resource', () => {
    // The three actions correspond exactly to the SDK calls in handlers.ts:
    //   findNativeClientiUserByEmail      → ListUsers
    //   linkGoogleIdentityToClientiUser   → AdminLinkProviderForUser
    //   updateClientiUserAttribute        → AdminUpdateUserAttributes
    const { stack } = buildStack();
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: Match.arrayWith([
              'cognito-idp:AdminLinkProviderForUser',
              'cognito-idp:ListUsers',
              'cognito-idp:AdminUpdateUserAttributes',
            ]),
            // A PolicyStatement with a single resource renders Resource as a
            // scalar string in CloudFormation (not a one-element array), so
            // match the string directly rather than wrapping in arrayWith.
            Resource: Match.stringLikeRegexp(
              'arn:aws:cognito-idp:eu-central-1:111122223333:userpool/\\*',
            ),
          }),
        ]),
      }),
    });
  });

  it('own LogGroup /aws/lambda/garageos-cognito-clienti-triggers is created', () => {
    const { stack } = buildStack();
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/aws/lambda/garageos-cognito-clienti-triggers',
    });
  });
});
