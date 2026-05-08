import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

// AWS Lambda function running the Fastify backend via the
// @fastify/aws-lambda adapter. The api package's index.ts wraps the
// Fastify instance and exports a Lambda handler that translates
// APIGW v2 events ↔ Fastify requests/responses entirely in-process —
// no HTTP localhost loop, no extension layer, no port mapping.
//
// Bundling: NodejsFunction L2 runs esbuild during synth. The api
// imports @garageos/database (workspace package, TS source) which
// imports the generated Prisma client. We external `@aws-sdk/*`
// (Lambda runtime ships it) and ship `@prisma/client` as nodeModules
// so its native engine binary is copied verbatim. The `prisma` CLI
// package is deliberately excluded — it bundles ~150 MB of cross-
// platform engine binaries and is only needed for `prisma migrate`,
// which we run from operator machines / CI, never from the Lambda.
//
// IAM in PR 21 was intentionally minimal: only secretsmanager:GetSecretValue
// on the appSecret ARN. PR 22 added Cognito admin scoped to the 2 user
// pool ARNs (pre-emptive). PR 23 adds S3 (s3:GetObject + s3:PutObject)
// scoped to the attachments bucket arn/* (pre-emptive — F-OFF-305 PR
// successivo userà la grant per signing presigned URLs).

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface LambdaApiConstructProps {
  readonly memoryMb: number;
  readonly architecture: 'arm64' | 'x86_64';
  readonly timeoutSec: number;
  readonly reservedConcurrency: number;
  readonly logRetentionDays: number;
  readonly appSecret: secretsmanager.ISecret;
  // Pre-emptive grant on these pool ARNs — the api code base will
  // start calling AdminCreateUser / AdminUpdateUserAttributes in the
  // PR that ships the signup-flow plumbing. Granting now keeps the
  // "construct ships its own IAM" invariant (vs. a follow-up chore PR).
  readonly officineUserPoolArn: string;
  readonly clientiUserPoolArn: string;
  // Pre-emptive grant: F-OFF-305 presigned upload endpoint (PR successivo)
  // userà s3:PutObject per signing PUT URLs e s3:GetObject per signed
  // GETs su attachments di intervention/dispute. Same pattern di Cognito
  // sopra — il PR che ship-a la risorsa ship-a anche il suo IAM.
  readonly attachmentsBucket: s3.IBucket;
  // Pre-emptive grant + env wiring: the api in PR G1 calls SES SendEmailCommand
  // for verify-email transactional flow. Same pattern as Cognito + S3 above —
  // construct ships its IAM and env wiring.
  readonly sesIdentityArn: string;
  readonly sesConfigurationSetArn: string;
  readonly sesFromAddress: string;
  readonly sesConfigurationSetName: string;
  readonly verifyEmailBaseUrl: string;
}

export class LambdaApiConstruct extends Construct {
  public readonly function: lambda.Function;
  public readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: LambdaApiConstructProps) {
    super(scope, id);

    const executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    props.appSecret.grantRead(executionRole);

    // Cognito admin actions used by future signup-flow / onboarding
    // endpoints. Scoped to the two pool ARNs (least-privilege).
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'cognito-idp:AdminGetUser',
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminUpdateUserAttributes',
          'cognito-idp:ListUsers',
        ],
        resources: [props.officineUserPoolArn, props.clientiUserPoolArn],
      }),
    );

    // S3 access pre-emptive grant. Raw policy (not L2 grantRead/grantPut)
    // perché gli helper espandono ad action set più largo del necessario:
    // grantRead aggiunge s3:List* (ListBucket esplicitamente escluso da
    // design Q4) + s3:GetBucket*; grantPut aggiunge s3:Abort* +
    // s3:PutObjectLegalHold/Retention/Tagging. Action minimi GetObject +
    // PutObject scoped object-level (no bucket-level).
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:PutObject'],
        resources: [`${props.attachmentsBucket.bucketArn}/*`],
      }),
    );

    // SES send (verify-email + future BR-064/066/129 notifications).
    // Scoped to identity + config set ARN (least privilege).
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: [props.sesIdentityArn, props.sesConfigurationSetArn],
      }),
    );

    this.logGroup = new logs.LogGroup(this, 'ApiLogGroup', {
      logGroupName: '/aws/lambda/garageos-api',
      retention: this.mapRetention(props.logRetentionDays),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const arch =
      props.architecture === 'arm64' ? lambda.Architecture.ARM_64 : lambda.Architecture.X86_64;

    // Entry resolves from <repo-root>/infrastructure/lib/constructs/
    // up three levels to <repo-root>/, then packages/api/src/index.ts.
    const entryPath = path.join(__dirname, '..', '..', '..', 'packages', 'api', 'src', 'index.ts');

    this.function = new lambdaNodejs.NodejsFunction(this, 'ApiFunction', {
      functionName: 'garageos-api',
      entry: entryPath,
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: arch,
      memorySize: props.memoryMb,
      timeout: cdk.Duration.seconds(props.timeoutSec),
      reservedConcurrentExecutions: props.reservedConcurrency,
      role: executionRole,
      logGroup: this.logGroup,
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        NODE_ENV: 'production',
        APP_SECRETS_ARN: props.appSecret.secretArn,
        // Make Node's TLS layer trust the Supabase root CA at process
        // startup. Required for sslmode=verify-full / verify-ca on the
        // Supabase pooler — the public Supabase root is not in Node's
        // default trust store. The cert itself is shipped into
        // /var/task/ via commandHooks.afterBundling below; see
        // infrastructure/assets/SUPABASE_CA_NOTES.md.
        NODE_EXTRA_CA_CERTS: '/var/task/supabase-ca.crt',
        // Bucket name esposto al runtime — il PR F-OFF-305 successivo
        // lo legge per signing presigned URL. Non-secret (visibile in
        // CfnOutput AttachmentsBucketName).
        S3_ATTACHMENTS_BUCKET: props.attachmentsBucket.bucketName,
        // SES wiring (PR G1). All non-secret — no SecretsManager entries needed.
        SES_FROM_ADDRESS: props.sesFromAddress,
        SES_CONFIGURATION_SET: props.sesConfigurationSetName,
        VERIFY_EMAIL_BASE_URL: props.verifyEmailBaseUrl,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
        format: lambdaNodejs.OutputFormat.ESM,
        // Inject a CommonJS-in-ESM compatibility shim. esbuild's ESM
        // output rewrites every static import as ESM but leaves
        // dynamic `require()` calls intact — and several transitive
        // deps (Fastify plugins, prisma client runtime helpers) call
        // `require('path')` / `require('fs')` lazily. Without this
        // banner the Lambda crashes at boot:
        //   Error: Dynamic require of "path" is not supported
        banner:
          "import{createRequire as __createRequire}from'module';const require=__createRequire(import.meta.url);",
        externalModules: ['@aws-sdk/*'],
        nodeModules: ['@prisma/client'],
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (_inputDir, outputDir) => [
            // Prisma 7's @prisma/client ships ~75 MB of WASM query
            // compilers covering every database vendor (cockroachdb,
            // mysql, postgresql, sqlite, sqlserver) × 2 size variants
            // × 2 module formats — plus @prisma/studio-core (38 MB)
            // and @prisma/dev (16 MB) of dev-time tooling. None of
            // that runs on Lambda — strip after install to keep the
            // unzipped bundle under the 250 MB AWS limit.
            //
            // The cleanup runs from a sibling .cjs script so we avoid
            // shell-quoting hell (bash -c on Linux CI vs cmd.exe on
            // Windows operator workstations) and keep the logic
            // testable in isolation if it grows.
            `node "${path.join(__dirname, '..', '..', 'scripts', 'strip-prisma-bloat.cjs')}" "${outputDir}"`,
            // Copy runtime assets (Supabase CA cert) into the bundle
            // root so /var/task/supabase-ca.crt is reachable by
            // NODE_EXTRA_CA_CERTS at Lambda cold start. See
            // infrastructure/scripts/copy-runtime-assets.cjs and
            // infrastructure/assets/SUPABASE_CA_NOTES.md.
            `node "${path.join(__dirname, '..', '..', 'scripts', 'copy-runtime-assets.cjs')}" "${outputDir}"`,
          ],
        },
      },
    });
  }

  /**
   * Attach EventBridge Scheduler runtime CRUD permissions to the Lambda's
   * execution role. Called from MainStack post-construction to break the
   * cyclic prop dependency between LambdaApiConstruct and SchedulerConstruct
   * (Lambda needs role+secret ARNs as env, Scheduler needs Lambda function
   * ARN). Same pattern as ses.grantSendEmail(lambdaApi.function).
   *
   * Resources are scoped to the deadline group + the role we PassRole to.
   * Even if the Lambda is compromised, it cannot CRUD schedules outside
   * its own group or escalate via PassRole on other AWS services.
   */
  public attachSchedulerPolicies(props: {
    scheduleGroupName: string;
    schedulerRoleArn: string;
    hmacSecret: secretsmanager.ISecret;
  }): void {
    const stack = cdk.Stack.of(this);

    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'scheduler:CreateSchedule',
          'scheduler:UpdateSchedule',
          'scheduler:DeleteSchedule',
          'scheduler:GetSchedule',
        ],
        resources: [
          `arn:aws:scheduler:${stack.region}:${stack.account}:schedule/${props.scheduleGroupName}/*`,
        ],
      }),
    );

    // PassRole is mandatory: scheduler:CreateSchedule passes the
    // SchedulerRole ARN as the schedule's executor. Without this
    // statement every CreateSchedule fails with AccessDenied.
    // Condition iam:PassedToService scopes the grant so the Lambda
    // cannot reuse the role for non-Scheduler privilege escalation.
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [props.schedulerRoleArn],
        conditions: {
          StringEquals: { 'iam:PassedToService': 'scheduler.amazonaws.com' },
        },
      }),
    );

    // HMAC secret read for signing future deadline HTTP callbacks.
    // grantRead handles both secretsmanager:GetSecretValue and
    // automatic KMS Decrypt when the secret uses a customer KMS key.
    props.hmacSecret.grantRead(this.function);
  }

  private mapRetention(days: number): logs.RetentionDays {
    switch (days) {
      case 7:
        return logs.RetentionDays.ONE_WEEK;
      case 14:
        return logs.RetentionDays.TWO_WEEKS;
      case 30:
        return logs.RetentionDays.ONE_MONTH;
      default:
        throw new Error(`Unsupported logRetentionDays: ${days}`);
    }
  }
}
