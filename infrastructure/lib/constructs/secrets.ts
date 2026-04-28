import * as cdk from 'aws-cdk-lib';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

// AWS Secrets Manager secret holding the seven runtime credentials
// the API container needs at boot. Provisioned with placeholder
// REPLACE_AFTER_DEPLOY values; the operator populates real values
// out-of-band via `aws secretsmanager update-secret` after the first
// deploy (see infrastructure/README.md step F7).
//
// Why all seven fields here: env.ts (packages/api/src/config/env.ts)
// fail-fasts at module load on any missing one. PR 21 ships placeholders
// for the four Cognito pool/client IDs that satisfy regex but point
// to nothing — the Lambda will boot, /health works, auth-protected
// routes 5xx until PR 22 ships the real Cognito construct.

export interface SecretsConstructProps {
  readonly environment: string;
}

export class SecretsConstruct extends Construct {
  public readonly appSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: SecretsConstructProps) {
    super(scope, id);

    this.appSecret = new secretsmanager.Secret(this, 'AppSecret', {
      secretName: `garageos/${props.environment}/app`,
      description: 'Runtime credentials for the GarageOS API (Supabase, Cognito, Sentry)',
      secretObjectValue: {
        DATABASE_URL: cdk.SecretValue.unsafePlainText('REPLACE_AFTER_DEPLOY'),
        DIRECT_URL: cdk.SecretValue.unsafePlainText('REPLACE_AFTER_DEPLOY'),
        COGNITO_OFFICINE_POOL_ID: cdk.SecretValue.unsafePlainText('REPLACE_AFTER_DEPLOY'),
        COGNITO_OFFICINE_CLIENT_ID: cdk.SecretValue.unsafePlainText('REPLACE_AFTER_DEPLOY'),
        COGNITO_CLIENTI_POOL_ID: cdk.SecretValue.unsafePlainText('REPLACE_AFTER_DEPLOY'),
        COGNITO_CLIENTI_CLIENT_ID: cdk.SecretValue.unsafePlainText('REPLACE_AFTER_DEPLOY'),
        SENTRY_DSN: cdk.SecretValue.unsafePlainText('REPLACE_AFTER_DEPLOY'),
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
  }
}
