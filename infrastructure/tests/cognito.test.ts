import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { CognitoConstruct } from '../lib/constructs/cognito.js';

// CognitoConstruct is stateless w.r.t. environment beyond the prop bag,
// so we synth once per describe block. CDK Templates are immutable
// after fromStack — sharing across `it` blocks is safe.
describe('CognitoConstruct (mfaTotpEnabled=true)', () => {
  function buildTemplate() {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestCognitoStack', {
      env: { account: '123456789012', region: 'eu-central-1' },
    });
    new CognitoConstruct(stack, 'Cognito', {
      environment: 'production',
      mfaTotpEnabled: true,
    });
    return Template.fromStack(stack);
  }
  const template = buildTemplate();

  it('provisions exactly two user pools', () => {
    template.resourceCountIs('AWS::Cognito::UserPool', 2);
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

  it('both user pools retain on stack deletion', () => {
    const pools = template.findResources('AWS::Cognito::UserPool');
    expect(Object.keys(pools)).toHaveLength(2);
    for (const pool of Object.values(pools)) {
      expect(pool.DeletionPolicy).toBe('Retain');
      expect(pool.UpdateReplacePolicy).toBe('Retain');
    }
  });

  it('provisions exactly two app clients with no client secret', () => {
    template.resourceCountIs('AWS::Cognito::UserPoolClient', 2);
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

  it('email is the sign-in alias on both pools (UsernameAttributes=email)', () => {
    const pools = template.findResources('AWS::Cognito::UserPool');
    expect(Object.keys(pools)).toHaveLength(2);
    for (const pool of Object.values(pools)) {
      expect(pool.Properties.UsernameAttributes).toEqual(['email']);
      expect(pool.Properties.AutoVerifiedAttributes).toEqual(['email']);
    }
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
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: 'garageos-production-officine',
      MfaConfiguration: 'OFF',
    });
  });
});
