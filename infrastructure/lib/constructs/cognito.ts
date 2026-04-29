import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

// Two Cognito user pools (officine + clienti) feeding the API JWT
// verifier (packages/api/src/plugins/auth.ts). Custom attributes match
// the claim shape the api consumes:
//   - officine: tenant_id, location_id, role (all string mutable)
//   - clienti:  customer_id (string mutable, UUID validated app-side)
//
// selfSignUpEnabled is FALSE on both pools — divergence from APPENDICE_C
// §5.5 documented in docs/superpowers/specs/2026-04-28-cognito-construct-design.md
// §4.1. Officine onboarding is server-driven via a future
// POST /v1/onboarding/officina; clienti signup is server-driven by a
// future POST /v1/auth/signup that calls AdminCreateUser with
// custom:customer_id pre-populated (clienti-context middleware requires
// this claim — packages/api/src/middleware/clienti-context.ts:18).
//
// removalPolicy is RETAIN — losing a user pool means losing every
// account in that pool, irreversibly.

export interface CognitoConstructProps {
  readonly environment: string;
  readonly mfaTotpEnabled: boolean;
}

export class CognitoConstruct extends Construct {
  public readonly officineUserPool: cognito.UserPool;
  public readonly officineClient: cognito.UserPoolClient;
  public readonly clientiUserPool: cognito.UserPool;
  public readonly clientiClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: CognitoConstructProps) {
    super(scope, id);

    this.officineUserPool = new cognito.UserPool(this, 'OfficineUserPool', {
      userPoolName: `garageos-${props.environment}-officine`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
        givenName: { required: true, mutable: true },
        familyName: { required: true, mutable: true },
      },
      customAttributes: {
        tenant_id: new cognito.StringAttribute({ mutable: true }),
        location_id: new cognito.StringAttribute({ mutable: true }),
        role: new cognito.StringAttribute({ mutable: true }),
      },
      passwordPolicy: {
        minLength: 10,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      mfa: props.mfaTotpEnabled ? cognito.Mfa.OPTIONAL : cognito.Mfa.OFF,
      mfaSecondFactor: { sms: false, otp: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.officineClient = this.officineUserPool.addClient('OfficineClient', {
      userPoolClientName: 'garageos-officine-client',
      authFlows: { userSrp: true, userPassword: true },
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
      preventUserExistenceErrors: true,
    });

    this.clientiUserPool = new cognito.UserPool(this, 'ClientiUserPool', {
      userPoolName: `garageos-${props.environment}-clienti`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
        givenName: { required: true, mutable: true },
        familyName: { required: true, mutable: true },
      },
      customAttributes: {
        customer_id: new cognito.StringAttribute({ mutable: true }),
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireDigits: true,
        requireUppercase: false,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      mfa: cognito.Mfa.OFF,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.clientiClient = this.clientiUserPool.addClient('ClientiClient', {
      userPoolClientName: 'garageos-clienti-client',
      authFlows: { userSrp: true, userPassword: true },
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(60),
      preventUserExistenceErrors: true,
    });
  }
}
