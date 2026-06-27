import * as cdk from 'aws-cdk-lib';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

// AWS Secrets Manager secret holding the runtime credentials the API
// container needs at boot (DATABASE_URL, DIRECT_URL, the Cognito
// pool/client IDs for officine/clienti/platform-admins, SENTRY_DSN —
// the full key list is owned by env.ts, packages/api/src/config/env.ts,
// which fail-fasts at module load on any missing one).
//
// IMPORTANT — the live secret value is a JSON object managed entirely
// OUT-OF-BAND by the operator (`aws secretsmanager put-secret-value`,
// see infrastructure/README.md step F7). The CloudFormation template
// ships ONLY the constant placeholder below; it deliberately does NOT
// enumerate the fields.
//
// Why: CloudFormation has no drift reconciliation — it rewrites the live
// SecretString only when the template value changes. When this construct
// embedded the field object (`secretObjectValue`), adding or removing any
// field changed the template and silently reset the WHOLE secret to
// placeholders on the next deploy, wiping operator-populated values and
// crashing the API at cold start (the #221 outage). A single constant
// placeholder is decoupled from the field list, so future credential
// changes never touch the template and can never trigger that reset.
//
// NEVER reintroduce a field object / secretObjectValue here. New runtime
// credentials are added to the live secret by the operator only. The
// regression test in infrastructure/tests/main-stack.test.ts locks this.
//
// ONE-TIME RESET ON THIS MIGRATION: the deploy that first introduces this
// constant changes the template SecretString (was the field object), so
// CloudFormation rewrites the live secret once. The operator must
// re-populate immediately after — see the runbook in README.md F7.

// Constant placeholder emitted into the CloudFormation template. It must
// never change — changing it is the one thing that resets the live secret.
// Kept as valid JSON (empty object) so the consumer's JSON.parse
// (packages/api/src/config/secrets.ts) succeeds on an unpopulated/fresh/DR
// stack and env.ts reports the missing fields cleanly, instead of crashing
// the Lambda with an opaque SyntaxError before any validation runs.
const APP_SECRET_PLACEHOLDER = '{}';

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
      secretStringValue: cdk.SecretValue.unsafePlainText(APP_SECRET_PLACEHOLDER),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
  }
}
