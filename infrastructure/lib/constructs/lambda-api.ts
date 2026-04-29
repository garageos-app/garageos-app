import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

// AWS Lambda function running the Fastify backend via Lambda Web Adapter
// (LWA) layer. LWA proxies Lambda events to a local HTTP server on
// AWS_LWA_PORT — application code stays a vanilla Fastify server, see
// packages/api/src/index.ts.
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
// IAM in PR 21 is intentionally minimal: only secretsmanager:GetSecretValue
// on the appSecret ARN. S3 / Cognito / SES / Scheduler permissions
// arrive in subsequent PRs together with the construct that needs them.

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

    this.logGroup = new logs.LogGroup(this, 'ApiLogGroup', {
      logGroupName: '/aws/lambda/garageos-api',
      retention: this.mapRetention(props.logRetentionDays),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // LWA layer ARN (verify at first deploy: layer version may have
    // bumped past 27 since 2026-04-23). Lookup command:
    //   aws lambda list-layer-versions --layer-name LambdaAdapterLayerArm64
    //     --region eu-central-1 --query 'LayerVersions[0].LayerVersionArn'
    const lwaLayer = lambda.LayerVersion.fromLayerVersionArn(
      this,
      'LwaLayer',
      `arn:aws:lambda:${cdk.Stack.of(this).region}:753240598075:layer:LambdaAdapterLayerArm64:27`,
    );

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
      layers: [lwaLayer],
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        NODE_ENV: 'production',
        // PORT is what the Fastify server reads (defaults to 3100 for
        // local dev). It MUST match AWS_LWA_PORT — LWA proxies Lambda
        // events to localhost:AWS_LWA_PORT, so Fastify needs to listen
        // there. The runbook had them aligned in spirit but no code
        // path actually set PORT in the Lambda env block, so Fastify
        // bound 3100 while LWA polled 8080 → "Lambda Web Adapter
        // should have intercepted this invocation" on every request.
        PORT: '8080',
        AWS_LWA_PORT: '8080',
        AWS_LWA_READINESS_CHECK_PATH: '/health',
        AWS_LWA_ASYNC_INIT: 'true',
        APP_SECRETS_ARN: props.appSecret.secretArn,
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
          ],
        },
      },
    });
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
