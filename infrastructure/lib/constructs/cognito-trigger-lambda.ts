import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

// Hardcoded function name shared between CognitoTriggerLambdaConstruct
// (Lambda + log group) and the CognitoConstruct (addTriggers call in MainStack).
// Single source of truth: changing this value here updates all call sites.
export const COGNITO_TRIGGER_FUNCTION_NAME = 'garageos-cognito-clienti-triggers';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface CognitoTriggerLambdaConstructProps {
  readonly environment: string;
  readonly appSecret: secretsmanager.ISecret;
  readonly architecture: 'arm64' | 'x86_64';
  readonly memoryMb: number;
  readonly timeoutSec: number;
  readonly logRetentionDays: number;
}

// AWS Lambda function handling Cognito clienti user pool triggers (PreSignUp,
// Pre-Token-Generation). Wired to the pool via addTriggers in MainStack after
// both the pool and this construct are instantiated.
//
// IAM deviation (Deviation 5): The Cognito-idp policy statement is scoped to
// `userpool/*` (region+account) rather than the concrete pool ARN. Using the
// concrete ARN would create a CFN dependency cycle:
//   pool.addTrigger → lambda → role → pool ARN (Fn::GetAtt) → pool
// CloudFormation cannot resolve this cycle. The `userpool/*` wildcard is still
// account+region-scoped (no cross-account escalation) and is a documented
// CDK/Cognito pattern for breaking trigger→pool cycles.
//
// The three cognito-idp actions correspond exactly to the three SDK calls in
// packages/api/src/cognito-triggers/handlers.ts:
//   findNativeClientiUserByEmail  → ListUsers
//   linkGoogleIdentityToClientiUser → AdminLinkProviderForUser
//   updateClientiUserAttribute      → AdminUpdateUserAttributes
export class CognitoTriggerLambdaConstruct extends Construct {
  public readonly function: lambda.Function;

  constructor(scope: Construct, id: string, props: CognitoTriggerLambdaConstructProps) {
    super(scope, id);

    const executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    props.appSecret.grantRead(executionRole);

    // Scoped to userpool/* (region+account) deliberately to avoid a CFN
    // dependency cycle (the pool addTrigger→lambda→role→pool would cycle if
    // the role referenced the concrete pool ARN). These 3 actions correspond
    // exactly to the SDK calls the trigger makes:
    //   findNativeClientiUserByEmail      → ListUsers
    //   linkGoogleIdentityToClientiUser   → AdminLinkProviderForUser
    //   updateClientiUserAttribute        → AdminUpdateUserAttributes
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'cognito-idp:AdminLinkProviderForUser',
          'cognito-idp:ListUsers',
          'cognito-idp:AdminUpdateUserAttributes',
        ],
        resources: [
          `arn:aws:cognito-idp:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:userpool/*`,
        ],
      }),
    );

    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/aws/lambda/${COGNITO_TRIGGER_FUNCTION_NAME}`,
      retention: this.mapRetention(props.logRetentionDays),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const arch =
      props.architecture === 'arm64' ? lambda.Architecture.ARM_64 : lambda.Architecture.X86_64;

    // Entry resolves from <repo-root>/infrastructure/lib/constructs/
    // up three levels to <repo-root>/, then packages/api/src/cognito-triggers/index.ts.
    const entryPath = path.join(
      __dirname,
      '..',
      '..',
      '..',
      'packages',
      'api',
      'src',
      'cognito-triggers',
      'index.ts',
    );

    this.function = new lambdaNodejs.NodejsFunction(this, 'TriggerFunction', {
      functionName: COGNITO_TRIGGER_FUNCTION_NAME,
      entry: entryPath,
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: arch,
      memorySize: props.memoryMb,
      timeout: cdk.Duration.seconds(props.timeoutSec),
      role: executionRole,
      logGroup,
      tracing: lambda.Tracing.ACTIVE,
      // No reservedConcurrentExecutions: Cognito triggers are low-volume;
      // omitting avoids consuming the account-level concurrency pool.
      environment: {
        NODE_ENV: 'production',
        APP_SECRETS_ARN: props.appSecret.secretArn,
        // Make Node's TLS layer trust the Supabase root CA at process startup.
        // Required for sslmode=verify-full on the Supabase pooler. The cert
        // is shipped into /var/task/ via commandHooks.afterBundling below.
        NODE_EXTRA_CA_CERTS: '/var/task/supabase-ca.crt',
        // No pool id/arn env var: the trigger reads event.userPoolId at
        // runtime (Cognito passes it in every trigger invocation payload),
        // avoiding any risk of re-introducing the dependency cycle.
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
        format: lambdaNodejs.OutputFormat.ESM,
        // Inject a CommonJS-in-ESM compatibility shim. esbuild's ESM output
        // rewrites every static import as ESM but leaves dynamic `require()`
        // calls intact — several transitive deps call `require('path')` /
        // `require('fs')` lazily. Without this banner the Lambda crashes at
        // boot: Error: Dynamic require of "path" is not supported.
        banner:
          "import{createRequire as __createRequire}from'module';const require=__createRequire(import.meta.url);",
        externalModules: ['@aws-sdk/*'],
        // Ship @prisma/client as a real node_modules package so its native
        // engine binary is copied verbatim. expo-server-sdk is intentionally
        // excluded — triggers never push notifications.
        nodeModules: ['@prisma/client'],
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (_inputDir, outputDir) => [
            // Strip Prisma 7's ~150 MB of WASM compilers and dev-time
            // tooling that are irrelevant at Lambda runtime, keeping the
            // unzipped bundle under the 250 MB AWS limit.
            `node "${path.join(__dirname, '..', '..', 'scripts', 'strip-prisma-bloat.cjs')}" "${outputDir}"`,
            // Copy runtime assets (Supabase CA cert) into the bundle root
            // so /var/task/supabase-ca.crt is reachable by NODE_EXTRA_CA_CERTS.
            `node "${path.join(__dirname, '..', '..', 'scripts', 'copy-runtime-assets.cjs')}" "${outputDir}"`,
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
