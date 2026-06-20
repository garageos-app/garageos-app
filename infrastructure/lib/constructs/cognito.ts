import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
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
  /** Optional Lambda to attach as PreSignUp and PreTokenGeneration triggers on the clienti pool. */
  readonly clientiTriggerFunction?: lambda.IFunction;
  /** OAuth callback URLs for the clienti app client (e.g. deep-link and web redirect). */
  readonly clientiCallbackUrls: string[];
  /** OAuth logout URLs for the clienti app client. */
  readonly clientiLogoutUrls: string[];
}

export class CognitoConstruct extends Construct {
  public readonly officineUserPool: cognito.UserPool;
  public readonly officineClient: cognito.UserPoolClient;
  public readonly clientiUserPool: cognito.UserPool;
  public readonly clientiClient: cognito.UserPoolClient;
  public readonly clientiUserPoolDomain: cognito.UserPoolDomain;

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

    // Google IdP for the clienti pool only.
    // unsafeUnwrap() here returns the {{resolve:secretsmanager:...}} CFN dynamic-reference
    // token string, NOT a plaintext secret. The actual secret value is resolved by
    // CloudFormation at deploy time and never lands in the synthesised template or repo.
    const googleIdp = new cognito.CfnUserPoolIdentityProvider(this, 'ClientiGoogleIdp', {
      userPoolId: this.clientiUserPool.userPoolId,
      providerName: 'Google',
      providerType: 'Google',
      providerDetails: {
        client_id: cdk.SecretValue.secretsManager(`garageos/${props.environment}/google-oauth`, {
          jsonField: 'client_id',
        }).unsafeUnwrap(),
        client_secret: cdk.SecretValue.secretsManager(
          `garageos/${props.environment}/google-oauth`,
          { jsonField: 'client_secret' },
        ).unsafeUnwrap(),
        authorize_scopes: 'openid email profile',
      },
      attributeMapping: {
        email: 'email',
        given_name: 'given_name',
        family_name: 'family_name',
        email_verified: 'email_verified',
      },
    });

    // Hosted UI domain for the clienti pool — required for the OAuth Authorization
    // Code + PKCE flow used by the mobile app and for Google's registered redirect URI.
    this.clientiUserPoolDomain = this.clientiUserPool.addDomain('ClientiHostedUiDomain', {
      cognitoDomain: { domainPrefix: `garageos-${props.environment}-clienti` },
    });

    this.clientiClient = this.clientiUserPool.addClient('ClientiClient', {
      userPoolClientName: 'garageos-clienti-client',
      authFlows: { userSrp: true, userPassword: true },
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(60),
      preventUserExistenceErrors: true,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: props.clientiCallbackUrls,
        logoutUrls: props.clientiLogoutUrls,
      },
      supportedIdentityProviders: [
        cognito.UserPoolClientIdentityProvider.COGNITO,
        cognito.UserPoolClientIdentityProvider.GOOGLE,
      ],
    });

    // The app client references Google as a supported IdP; CFN requires the IdP
    // resource to exist before the client that lists it.
    this.clientiClient.node.addDependency(googleIdp);

    // Attach Lambda triggers to the clienti pool when provided.
    // The same function handles both PreSignUp (Google account linking) and
    // PreTokenGeneration (inject custom:customer_id claim).
    if (props.clientiTriggerFunction) {
      this.clientiUserPool.addTrigger(
        cognito.UserPoolOperation.PRE_SIGN_UP,
        props.clientiTriggerFunction,
      );
      this.clientiUserPool.addTrigger(
        cognito.UserPoolOperation.PRE_TOKEN_GENERATION,
        props.clientiTriggerFunction,
      );
    }
  }
}
