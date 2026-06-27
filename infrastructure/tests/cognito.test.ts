import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { CognitoConstruct } from '../lib/constructs/cognito.js';

const STUB_CALLBACK_URLS = ['garageos://auth/callback', 'https://example.com/callback'];
const STUB_LOGOUT_URLS = ['garageos://auth/logout', 'https://example.com/logout'];

// CognitoConstruct is stateless w.r.t. environment beyond the prop bag,
// so we synth once per describe block. CDK Templates are immutable
// after fromStack — sharing across `it` blocks is safe.
describe('CognitoConstruct (mfaTotpEnabled=true)', () => {
  function buildTemplate() {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestCognitoStack', {
      env: { account: '123456789012', region: 'eu-central-1' },
    });
    // Stub Lambda function so triggers and OAuth paths are fully exercised during synth.
    const stubTrigger = new lambda.Function(stack, 'StubTrigger', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler=async()=>{}'),
    });
    new CognitoConstruct(stack, 'Cognito', {
      environment: 'production',
      mfaTotpEnabled: true,
      clientiTriggerFunction: stubTrigger,
      clientiCallbackUrls: STUB_CALLBACK_URLS,
      clientiLogoutUrls: STUB_LOGOUT_URLS,
    });
    return Template.fromStack(stack);
  }
  const template = buildTemplate();

  it('provisions exactly three user pools', () => {
    template.resourceCountIs('AWS::Cognito::UserPool', 3);
  });

  it('officine user pool has correct name, custom attributes, password policy', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: 'garageos-production-officine',
      AdminCreateUserConfig: Match.objectLike({
        AllowAdminCreateUserOnly: true,
      }),
      Schema: Match.arrayWith([
        Match.objectLike({ Name: 'tenant_id', AttributeDataType: 'String', Mutable: true }),
        Match.objectLike({ Name: 'location_id', AttributeDataType: 'String', Mutable: true }),
        Match.objectLike({ Name: 'role', AttributeDataType: 'String', Mutable: true }),
      ]),
      Policies: Match.objectLike({
        PasswordPolicy: Match.objectLike({
          MinimumLength: 10,
          RequireLowercase: true,
          RequireUppercase: true,
          RequireNumbers: true,
          RequireSymbols: false,
        }),
      }),
    });
  });

  it('officine user pool has MFA OPTIONAL with TOTP only', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: 'garageos-production-officine',
      MfaConfiguration: 'OPTIONAL',
      EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
    });
  });

  it('clienti user pool has correct name, customer_id custom attribute, lighter password policy', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: 'garageos-production-clienti',
      AdminCreateUserConfig: Match.objectLike({
        AllowAdminCreateUserOnly: true,
      }),
      Schema: Match.arrayWith([
        Match.objectLike({ Name: 'customer_id', AttributeDataType: 'String', Mutable: true }),
      ]),
      Policies: Match.objectLike({
        PasswordPolicy: Match.objectLike({
          MinimumLength: 8,
          RequireLowercase: true,
          RequireNumbers: true,
          RequireUppercase: false,
          RequireSymbols: false,
        }),
      }),
    });
  });

  it('clienti user pool has MFA OFF', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: 'garageos-production-clienti',
      MfaConfiguration: 'OFF',
    });
  });

  it('all user pools retain on stack deletion', () => {
    const pools = template.findResources('AWS::Cognito::UserPool');
    expect(Object.keys(pools)).toHaveLength(3);
    for (const pool of Object.values(pools)) {
      expect(pool.DeletionPolicy).toBe('Retain');
      expect(pool.UpdateReplacePolicy).toBe('Retain');
    }
  });

  it('provisions exactly three app clients with no client secret', () => {
    template.resourceCountIs('AWS::Cognito::UserPoolClient', 3);
    const clients = template.findResources('AWS::Cognito::UserPoolClient');
    for (const client of Object.values(clients)) {
      expect(client.Properties.GenerateSecret).toBeUndefined();
    }
  });

  it('officine app client uses SRP + USER_PASSWORD flows with 30-day refresh', () => {
    const clients = template.findResources('AWS::Cognito::UserPoolClient');
    const officineClient = Object.values(clients).find(
      (c) => c.Properties?.ClientName === 'garageos-officine-client',
    );
    expect(officineClient).toBeDefined();
    expect(officineClient?.Properties?.ExplicitAuthFlows).toContain('ALLOW_USER_SRP_AUTH');
    expect(officineClient?.Properties?.ExplicitAuthFlows).toContain('ALLOW_USER_PASSWORD_AUTH');
    expect(officineClient?.Properties?.ExplicitAuthFlows).toContain('ALLOW_REFRESH_TOKEN_AUTH');
    expect(officineClient?.Properties?.AccessTokenValidity).toBe(60);
    expect(officineClient?.Properties?.IdTokenValidity).toBe(60);
    expect(officineClient?.Properties?.RefreshTokenValidity).toBe(30 * 24 * 60);
    expect(officineClient?.Properties?.PreventUserExistenceErrors).toBe('ENABLED');
  });

  it('clienti app client uses SRP + USER_PASSWORD flows with 60-day refresh', () => {
    const clients = template.findResources('AWS::Cognito::UserPoolClient');
    const clientiClient = Object.values(clients).find(
      (c) => c.Properties?.ClientName === 'garageos-clienti-client',
    );
    expect(clientiClient).toBeDefined();
    expect(clientiClient?.Properties?.ExplicitAuthFlows).toContain('ALLOW_USER_SRP_AUTH');
    expect(clientiClient?.Properties?.ExplicitAuthFlows).toContain('ALLOW_USER_PASSWORD_AUTH');
    expect(clientiClient?.Properties?.ExplicitAuthFlows).toContain('ALLOW_REFRESH_TOKEN_AUTH');
    expect(clientiClient?.Properties?.AccessTokenValidity).toBe(60);
    expect(clientiClient?.Properties?.IdTokenValidity).toBe(60);
    expect(clientiClient?.Properties?.RefreshTokenValidity).toBe(60 * 24 * 60);
    expect(clientiClient?.Properties?.PreventUserExistenceErrors).toBe('ENABLED');
  });

  it('email is the sign-in alias on all pools (UsernameAttributes=email)', () => {
    const pools = template.findResources('AWS::Cognito::UserPool');
    expect(Object.keys(pools)).toHaveLength(3);
    for (const pool of Object.values(pools)) {
      expect(pool.Properties.UsernameAttributes).toEqual(['email']);
      expect(pool.Properties.AutoVerifiedAttributes).toEqual(['email']);
    }
  });

  it('platform-admins user pool has correct name, admin-create-only, and matching password policy', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: 'garageos-production-platform-admins',
      AdminCreateUserConfig: Match.objectLike({
        AllowAdminCreateUserOnly: true,
      }),
      Policies: Match.objectLike({
        PasswordPolicy: Match.objectLike({
          MinimumLength: 10,
          RequireLowercase: true,
          RequireUppercase: true,
          RequireNumbers: true,
          RequireSymbols: false,
        }),
      }),
    });
  });

  it('platform-admins user pool has MFA OFF', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: 'garageos-production-platform-admins',
      MfaConfiguration: 'OFF',
    });
  });

  it('platform-admins user pool has no tenant_id or role custom attributes in its Schema', () => {
    const pools = template.findResources('AWS::Cognito::UserPool');
    const platformAdminsPool = Object.values(pools).find(
      (p) => p.Properties?.UserPoolName === 'garageos-production-platform-admins',
    );
    expect(platformAdminsPool).toBeDefined();
    const schema: Array<{ Name?: string }> = platformAdminsPool?.Properties?.Schema ?? [];
    const customAttrNames = schema.map((attr) => attr.Name).filter(Boolean);
    expect(customAttrNames).not.toContain('tenant_id');
    expect(customAttrNames).not.toContain('role');
  });

  it('platform-admins app client uses SRP + USER_PASSWORD flows with 30-day refresh, no oAuth', () => {
    const clients = template.findResources('AWS::Cognito::UserPoolClient');
    const platformAdminsClient = Object.values(clients).find(
      (c) => c.Properties?.ClientName === 'garageos-platform-admins-client',
    );
    expect(platformAdminsClient).toBeDefined();
    expect(platformAdminsClient?.Properties?.ExplicitAuthFlows).toContain('ALLOW_USER_SRP_AUTH');
    expect(platformAdminsClient?.Properties?.ExplicitAuthFlows).toContain(
      'ALLOW_USER_PASSWORD_AUTH',
    );
    expect(platformAdminsClient?.Properties?.ExplicitAuthFlows).toContain(
      'ALLOW_REFRESH_TOKEN_AUTH',
    );
    expect(platformAdminsClient?.Properties?.AccessTokenValidity).toBe(60);
    expect(platformAdminsClient?.Properties?.IdTokenValidity).toBe(60);
    expect(platformAdminsClient?.Properties?.RefreshTokenValidity).toBe(30 * 24 * 60);
    expect(platformAdminsClient?.Properties?.PreventUserExistenceErrors).toBe('ENABLED');
    // No oAuth — no AllowedOAuthFlows, no CallbackURLs
    expect(platformAdminsClient?.Properties?.AllowedOAuthFlows).toBeUndefined();
    expect(platformAdminsClient?.Properties?.CallbackURLs).toBeUndefined();
  });

  // --- Google IdP assertions ---

  it('provisions exactly one Google IdP on the clienti pool', () => {
    template.resourceCountIs('AWS::Cognito::UserPoolIdentityProvider', 1);
    template.hasResourceProperties('AWS::Cognito::UserPoolIdentityProvider', {
      ProviderName: 'Google',
      ProviderType: 'Google',
      ProviderDetails: Match.objectLike({
        authorize_scopes: 'openid email profile',
        // client_id and client_secret are CFN dynamic references resolved at deploy time —
        // the synthesised template contains {{resolve:secretsmanager:...}} tokens, not plaintext.
        client_id: Match.stringLikeRegexp('\\{\\{resolve:secretsmanager:'),
        client_secret: Match.stringLikeRegexp('\\{\\{resolve:secretsmanager:'),
      }),
      AttributeMapping: {
        email: 'email',
        given_name: 'given_name',
        family_name: 'family_name',
        email_verified: 'email_verified',
      },
    });
  });

  // --- Hosted UI domain assertion ---

  it('provisions a Cognito hosted-UI domain for the clienti pool', () => {
    template.resourceCountIs('AWS::Cognito::UserPoolDomain', 1);
    template.hasResourceProperties('AWS::Cognito::UserPoolDomain', {
      Domain: 'garageos-production-clienti',
    });
  });

  // --- Clienti client OAuth assertions ---

  it('clienti app client has OAuth Authorization Code flow, scopes, IdPs, callback/logout URLs', () => {
    const clients = template.findResources('AWS::Cognito::UserPoolClient');
    const clientiClient = Object.values(clients).find(
      (c) => c.Properties?.ClientName === 'garageos-clienti-client',
    );
    expect(clientiClient).toBeDefined();
    expect(clientiClient?.Properties?.AllowedOAuthFlows).toContain('code');
    expect(clientiClient?.Properties?.AllowedOAuthScopes).toEqual(
      expect.arrayContaining(['openid', 'email', 'profile']),
    );
    expect(clientiClient?.Properties?.SupportedIdentityProviders).toContain('Google');
    expect(clientiClient?.Properties?.SupportedIdentityProviders).toContain('COGNITO');
    expect(clientiClient?.Properties?.CallbackURLs).toEqual(STUB_CALLBACK_URLS);
    expect(clientiClient?.Properties?.LogoutURLs).toEqual(STUB_LOGOUT_URLS);
  });

  // --- Lambda trigger assertions ---

  it('clienti user pool has PreSignUp and PreTokenGeneration triggers set', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: 'garageos-production-clienti',
      LambdaConfig: Match.objectLike({
        PreSignUp: Match.anyValue(),
        PreTokenGeneration: Match.anyValue(),
      }),
    });
  });
});

describe('CognitoConstruct (mfaTotpEnabled=false)', () => {
  it('officine user pool has MFA OFF when toggle is false', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestCognitoStackNoMfa', {
      env: { account: '123456789012', region: 'eu-central-1' },
    });
    new CognitoConstruct(stack, 'Cognito', {
      environment: 'production',
      mfaTotpEnabled: false,
      clientiCallbackUrls: STUB_CALLBACK_URLS,
      clientiLogoutUrls: STUB_LOGOUT_URLS,
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: 'garageos-production-officine',
      MfaConfiguration: 'OFF',
    });
  });
});
