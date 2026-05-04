# PR 23 — Storage (S3 attachments) + WAF (REGIONAL) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `StorageConstruct` (S3 attachments bucket) and `WafConstruct` (REGIONAL Web ACL) to `GarageosMainStack`, wire WAF association al default stage di API Gateway, grant pre-emptive minimo (`s3:GetObject` + `s3:PutObject`) sulla Lambda execution role, esporre `S3_ATTACHMENTS_BUCKET` env var al runtime.

**Architecture:** Due nuovi construct paralleli al pattern esistente (Cognito/LambdaApi/ApiGateway). Composition fatta in `MainStack`: Storage instanziato prima di LambdaApi (dep graph), WAF + association dopo ApiGateway. Tutto resta in singolo stack `GarageosMainStack` (decisione "stack-split deferred" da `main-stack.ts:11-13`).

**Tech Stack:** AWS CDK v2 TypeScript, `aws-cdk-lib/aws-s3`, `aws-cdk-lib/aws-wafv2`, `aws-cdk-lib/aws-iam`, Vitest + `aws-cdk-lib/assertions` per test, NodeNext ESM con `.js` import suffix.

**Spec:** `docs/superpowers/specs/2026-05-04-cdk-storage-waf-design.md`

---

## File Structure

| File | Type | Responsibility |
|---|---|---|
| `infrastructure/lib/constructs/storage.ts` | NEW | StorageConstruct: 1 bucket S3 attachments con encryption/CORS/lifecycle/versioning. |
| `infrastructure/lib/constructs/waf.ts` | NEW | WafConstruct: 1 Web ACL WAFv2 REGIONAL con 3 rule. |
| `infrastructure/lib/constructs/api-gateway.ts` | MODIFY | Esporre `defaultStage` per consumo dal MainStack. |
| `infrastructure/lib/constructs/lambda-api.ts` | MODIFY | Accetta `attachmentsBucket` prop, grant raw S3 minimo, env var `S3_ATTACHMENTS_BUCKET`. |
| `infrastructure/lib/config/production.ts` | MODIFY | Sub-config `waf.rateLimitPer5Min`. |
| `infrastructure/lib/stacks/main-stack.ts` | MODIFY | Instanzia Storage+WAF, wira IAM, crea `CfnWebACLAssociation`, +`CfnOutput`. |
| `infrastructure/tests/storage-waf.test.ts` | NEW | 15 assertion test (8 storage + 7 WAF). |
| `infrastructure/tests/main-stack.test.ts` | MODIFY | +4 expect (output bucket + ACL ARN, association presente, S3 grant IAM). |
| `infrastructure/README.md` | MODIFY | Nuove sezioni F-Storage + F-WAF nel runbook. |
| `docs/APPENDICE_C_INFRASTRUCTURE.md` | MODIFY | Riconciliazione §5.4 CORS origins reali + changelog v1.3. |

---

## Tasks

### Task 1: Add StorageConstruct + tests

**Files:**
- Create: `infrastructure/lib/constructs/storage.ts`
- Create: `infrastructure/tests/storage-waf.test.ts`

- [ ] **Step 1: Create the test file with storage assertions**

Crea `infrastructure/tests/storage-waf.test.ts`:

```typescript
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, it } from 'vitest';

import { StorageConstruct } from '../lib/constructs/storage.js';

describe('StorageConstruct', () => {
  function buildTemplate(): Template {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStorageStack', {
      env: { account: '123456789012', region: 'eu-central-1' },
    });
    new StorageConstruct(stack, 'Storage', {
      environment: 'production',
      corsAllowedOrigins: [
        'https://app.garageos.aifollyadvisor.com',
        'https://garageos.aifollyadvisor.com',
      ],
    });
    return Template.fromStack(stack);
  }

  it('provisions exactly one S3 bucket with the expected name', () => {
    const template = buildTemplate();
    template.resourceCountIs('AWS::S3::Bucket', 1);
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: 'garageos-production-attachments',
    });
  });

  it('enforces server-side encryption (S3-managed AES256)', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: Match.arrayWith([
          Match.objectLike({
            ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' },
          }),
        ]),
      },
    });
  });

  it('blocks all public access', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('enables object versioning', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
    });
  });

  it('configures CORS with 2 allowed origins (app + apex), GET+PUT methods', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::S3::Bucket', {
      CorsConfiguration: {
        CorsRules: Match.arrayWith([
          Match.objectLike({
            AllowedMethods: Match.arrayWith(['GET', 'PUT']),
            AllowedOrigins: [
              'https://app.garageos.aifollyadvisor.com',
              'https://garageos.aifollyadvisor.com',
            ],
            AllowedHeaders: ['*'],
            MaxAge: 3000,
          }),
        ]),
      },
    });
  });

  it('configures lifecycle rule: transition to IA after 90 days + noncurrent expiry 30d', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Id: 'transition-to-ia',
            Status: 'Enabled',
            Transitions: Match.arrayWith([
              Match.objectLike({
                StorageClass: 'STANDARD_IA',
                TransitionInDays: 90,
              }),
            ]),
            NoncurrentVersionExpiration: { NoncurrentDays: 30 },
          }),
        ]),
      },
    });
  });

  it('configures lifecycle rule: abort incomplete uploads after 7 days', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Id: 'abort-incomplete-uploads',
            Status: 'Enabled',
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
          }),
        ]),
      },
    });
  });

  it('retains the bucket on stack deletion', () => {
    const template = buildTemplate();
    template.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail (import error — module not yet created)**

Run: `pnpm --filter infrastructure test`
Expected: FAIL — `Failed to resolve import "../lib/constructs/storage.js"`. This is the natural TDD failure: the construct module doesn't exist yet.

- [ ] **Step 3: Create the StorageConstruct implementation**

Crea `infrastructure/lib/constructs/storage.ts`:

```typescript
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

// S3 bucket per allegati intervention/dispute. Upload via presigned
// URL (PR successivo F-OFF-305) — il bucket NON è pubblicamente
// accessibile, ogni operazione passa da signed URL Lambda-side.
//
// Lifecycle:
// - transition-to-ia: oggetti dopo 90 giorni → Standard-IA (~40% saving
//   storage cost) per allegati storici raramente acceduti.
// - noncurrent versions expire dopo 30 giorni — la versioning protegge
//   da overwrite accidentali ma non dobbiamo accumulare storia infinita.
// - abort-incomplete-uploads dopo 7 giorni — multipart abbandonati
//   trattenuti consumano storage (rare ma capita su upload mobili
//   interrotti).
//
// CORS: solo origini browser-served (app.garageos.* + garageos.*).
// Mobile (RN/Expo) non rispetta CORS, quindi non serve elencarlo.
//
// removalPolicy RETAIN: perdere il bucket = perdere allegati di tutti
// gli workshop. Cleanup manuale solo via console se necessario.

export interface StorageConstructProps {
  readonly environment: string;
  readonly corsAllowedOrigins: readonly string[];
}

export class StorageConstruct extends Construct {
  public readonly attachmentsBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: StorageConstructProps) {
    super(scope, id);

    this.attachmentsBucket = new s3.Bucket(this, 'Attachments', {
      bucketName: `garageos-${props.environment}-attachments`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      lifecycleRules: [
        {
          id: 'transition-to-ia',
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(90),
            },
          ],
          noncurrentVersionExpiration: cdk.Duration.days(30),
        },
        {
          id: 'abort-incomplete-uploads',
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
      ],
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT],
          allowedOrigins: [...props.corsAllowedOrigins],
          allowedHeaders: ['*'],
          maxAge: 3000,
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter infrastructure test`
Expected: PASS — all 8 StorageConstruct tests green.

- [ ] **Step 5: Run typecheck**

Run: `pnpm --filter infrastructure typecheck`
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add infrastructure/lib/constructs/storage.ts infrastructure/tests/storage-waf.test.ts
git commit -m "$(cat <<'EOF'
feat(infra): add StorageConstruct with attachments bucket

S3 bucket garageos-production-attachments per allegati intervention/
dispute. Encryption AES256, BlockPublicAccess all, versioned, lifecycle
(transition IA 90gg + noncurrent expire 30gg + abort multipart 7gg),
CORS GET+PUT per origin app/apex, RETAIN policy.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Add WafConstruct + tests

**Files:**
- Create: `infrastructure/lib/constructs/waf.ts`
- Modify: `infrastructure/tests/storage-waf.test.ts` (add WAF describe block)

- [ ] **Step 1: Append WAF tests to the existing test file**

Aggiungi questo `describe` block al fondo di `infrastructure/tests/storage-waf.test.ts`, dopo il `describe('StorageConstruct', ...)`:

```typescript
import { WafConstruct } from '../lib/constructs/waf.js';

describe('WafConstruct', () => {
  function buildTemplate(): Template {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestWafStack', {
      env: { account: '123456789012', region: 'eu-central-1' },
    });
    new WafConstruct(stack, 'Waf', {
      environment: 'production',
      rateLimitPer5Min: 2000,
    });
    return Template.fromStack(stack);
  }

  it('provisions exactly one Web ACL with REGIONAL scope and expected name', () => {
    const template = buildTemplate();
    template.resourceCountIs('AWS::WAFv2::WebACL', 1);
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Scope: 'REGIONAL',
      Name: 'garageos-production-api-waf',
    });
  });

  it('default action is allow', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      DefaultAction: { Allow: {} },
    });
  });

  it('provisions 3 rules with expected priorities and names', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Rules: [
        Match.objectLike({ Name: 'AWS-ManagedRulesCommonRuleSet', Priority: 1 }),
        Match.objectLike({ Name: 'AWS-ManagedRulesKnownBadInputsRuleSet', Priority: 2 }),
        Match.objectLike({ Name: 'RateLimitIp', Priority: 3 }),
      ],
    });
  });

  it('applies AWS managed CommonRuleSet at priority 1 with overrideAction none', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Rules: Match.arrayWith([
        Match.objectLike({
          Name: 'AWS-ManagedRulesCommonRuleSet',
          OverrideAction: { None: {} },
          Statement: {
            ManagedRuleGroupStatement: {
              VendorName: 'AWS',
              Name: 'AWSManagedRulesCommonRuleSet',
            },
          },
        }),
      ]),
    });
  });

  it('applies AWS managed KnownBadInputsRuleSet at priority 2', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Rules: Match.arrayWith([
        Match.objectLike({
          Name: 'AWS-ManagedRulesKnownBadInputsRuleSet',
          OverrideAction: { None: {} },
          Statement: {
            ManagedRuleGroupStatement: {
              VendorName: 'AWS',
              Name: 'AWSManagedRulesKnownBadInputsRuleSet',
            },
          },
        }),
      ]),
    });
  });

  it('rate-limits to 2000 requests per 5min per IP at priority 3 (block action)', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Rules: Match.arrayWith([
        Match.objectLike({
          Name: 'RateLimitIp',
          Action: { Block: {} },
          Statement: {
            RateBasedStatement: {
              Limit: 2000,
              AggregateKeyType: 'IP',
            },
          },
        }),
      ]),
    });
  });

  it('enables CloudWatch metrics on the ACL with metricName "GarageosWaf"', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      VisibilityConfig: {
        CloudWatchMetricsEnabled: true,
        SampledRequestsEnabled: true,
        MetricName: 'GarageosWaf',
      },
    });
  });
});
```

- [ ] **Step 2: Run tests to verify WAF tests fail (import error)**

Run: `pnpm --filter infrastructure test`
Expected: FAIL — `Failed to resolve import "../lib/constructs/waf.js"`.

- [ ] **Step 3: Create the WafConstruct implementation**

Crea `infrastructure/lib/constructs/waf.ts`:

```typescript
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';

// WAFv2 Web ACL REGIONAL scope per API Gateway HTTP API v2
// (eu-central-1). 3 rule da APPENDICE_C §5.8:
// 1. CommonRuleSet — OWASP Top 10 baseline (AWS managed)
// 2. KnownBadInputs — exploit signature pattern (AWS managed)
// 3. RateLimitIp — 2000 req/5min per IP (eventually consistent)
//
// L'association al stage default è creata in MainStack (cross-construct
// composition). CLOUDFRONT scope NON è in scope di questo construct
// (sblocca con CloudFront in PR 25 — cross-region us-east-1).
//
// metricName 'GarageosWaf' allineato a APPENDICE_C §5.8 letterale.
// Per-rule metricName usa il rule name AWS managed (CommonRuleSet,
// KnownBadInputs) per tracciamento separato in CloudWatch.

export interface WafConstructProps {
  readonly environment: string;
  readonly rateLimitPer5Min: number;
}

export class WafConstruct extends Construct {
  public readonly webAcl: wafv2.CfnWebACL;

  constructor(scope: Construct, id: string, props: WafConstructProps) {
    super(scope, id);

    this.webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      name: `garageos-${props.environment}-api-waf`,
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        sampledRequestsEnabled: true,
        metricName: 'GarageosWaf',
      },
      rules: [
        {
          name: 'AWS-ManagedRulesCommonRuleSet',
          priority: 1,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            sampledRequestsEnabled: true,
            metricName: 'AWSManagedRulesCommonRuleSet',
          },
        },
        {
          name: 'AWS-ManagedRulesKnownBadInputsRuleSet',
          priority: 2,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesKnownBadInputsRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            sampledRequestsEnabled: true,
            metricName: 'AWSManagedRulesKnownBadInputsRuleSet',
          },
        },
        {
          name: 'RateLimitIp',
          priority: 3,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: props.rateLimitPer5Min,
              aggregateKeyType: 'IP',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            sampledRequestsEnabled: true,
            metricName: 'RateLimitIp',
          },
        },
      ],
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter infrastructure test`
Expected: PASS — 8 storage tests + 7 WAF tests = 15 nuovi test green; baseline 31 invariati.

- [ ] **Step 5: Run typecheck**

Run: `pnpm --filter infrastructure typecheck`
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add infrastructure/lib/constructs/waf.ts infrastructure/tests/storage-waf.test.ts
git commit -m "$(cat <<'EOF'
feat(infra): add WafConstruct with REGIONAL Web ACL

Web ACL WAFv2 REGIONAL per API Gateway HTTP API v2 con 3 rule da
APPENDICE_C §5.8: CommonRuleSet (priority 1, override none),
KnownBadInputs (priority 2, override none), RateLimitIp 2000/5min
(priority 3, block action). CloudWatch metrics enabled per ACL e
ogni rule. Association al stage creata in MainStack (cross-construct).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Expose ApiGateway default stage

**Files:**
- Modify: `infrastructure/lib/constructs/api-gateway.ts`

- [ ] **Step 1: Add `defaultStage` public readonly property**

In `infrastructure/lib/constructs/api-gateway.ts`, dopo la classe property declaration linea ~38 (dopo `accessLogGroup`), aggiungi:

```typescript
  public readonly httpApi: apigw.HttpApi;
  public readonly domainName: apigw.DomainName;
  public readonly accessLogGroup: logs.LogGroup;
  public readonly defaultStage: apigw.IStage;  // NEW — exposed for WAF association in MainStack
```

Poi nel constructor, dopo `this.httpApi.addRoutes(...)` (line ~93-97), aggiungi:

```typescript
    this.httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [apigw.HttpMethod.ANY],
      integration,
    });

    // Stage exposed for downstream WAF association. Always non-null
    // after addRoutes — HTTP API v2 auto-creates a $default stage.
    this.defaultStage = this.httpApi.defaultStage!;
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm --filter infrastructure typecheck`
Expected: zero errors.

- [ ] **Step 3: Run all tests to verify no regression**

Run: `pnpm --filter infrastructure test`
Expected: PASS — 31 baseline + 15 nuovi storage-waf = 46 totali.

- [ ] **Step 4: Commit**

```bash
git add infrastructure/lib/constructs/api-gateway.ts
git commit -m "$(cat <<'EOF'
feat(infra): expose ApiGateway default stage for WAF association

Aggiunge public readonly defaultStage a ApiGatewayConstruct così il
MainStack può creare la CfnWebACLAssociation cross-construct senza
toccare l'internals dell'HttpApi. Non-null assertion safe — HTTP API
v2 auto-crea sempre un $default stage dopo addRoutes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: LambdaApi accepts attachmentsBucket prop + raw S3 grant + env var

**Files:**
- Modify: `infrastructure/lib/constructs/lambda-api.ts`

- [ ] **Step 1: Add s3 import and attachmentsBucket prop**

In `infrastructure/lib/constructs/lambda-api.ts`, aggiungi import dopo gli esistenti (around line 9):

```typescript
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
```

(Nota: `secretsmanager` import esiste già; aggiungere SOLO `s3`.)

Modifica l'interface `LambdaApiConstructProps` (around line 34-47) aggiungendo l'ultima prop:

```typescript
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
}
```

- [ ] **Step 2: Add raw S3 policy statement and env var**

Nel constructor, dopo il blocco Cognito policy (around line 76), aggiungi:

```typescript
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
```

- [ ] **Step 3: Add `S3_ATTACHMENTS_BUCKET` to Lambda environment**

Modifica il blocco `environment:` nella `NodejsFunction` (around line 103-113):

```typescript
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
      },
```

- [ ] **Step 4: Update header comment for the new IAM grant section**

Aggiorna il blocco di commento esistente alle linee 26-29 di `lambda-api.ts` per riflettere lo stato corrente:

```typescript
// IAM in PR 21 was intentionally minimal: only secretsmanager:GetSecretValue
// on the appSecret ARN. PR 22 added Cognito admin scoped to the 2 user
// pool ARNs (pre-emptive). PR 23 adds S3 (s3:GetObject + s3:PutObject)
// scoped to the attachments bucket arn/* (pre-emptive — F-OFF-305 PR
// successivo userà la grant per signing presigned URLs).
```

- [ ] **Step 5: Run typecheck**

Run: `pnpm --filter infrastructure typecheck`
Expected: zero errors.

- [ ] **Step 6: Run all tests — main-stack tests will FAIL because LambdaApiConstructProps now requires attachmentsBucket**

Run: `pnpm --filter infrastructure test`
Expected: FAIL — main-stack.test.ts errors due to missing required prop. Questo è atteso e verrà risolto in Task 6 dove MainStack passa la prop.

**Nota:** non committare ancora — il build è rotto e Task 5/6 lo risolvono.

---

### Task 5: Add WAF config to productionConfig

**Files:**
- Modify: `infrastructure/lib/config/production.ts`

- [ ] **Step 1: Add waf sub-config to interface and value**

Modifica `infrastructure/lib/config/production.ts`:

```typescript
// Production environment configuration for the GarageOS CDK app.
// Single env in v1 — staging is deferred. When staging is added,
// this file becomes one of multiple `<env>.ts` modules selected by
// the bin entry point via process.env.GARAGEOS_ENV.
//
// `synthMock` is set when CDK_SYNTH_MOCK=true is in the environment
// (CI gate). When true, DnsConstruct skips Route53 hosted-zone
// lookups (which require AWS account context) and uses synthetic
// values so `cdk synth` succeeds offline.

export interface EnvironmentConfig {
  readonly environment: 'production';
  readonly domainName: string;
  readonly apiSubdomain: string;
  readonly appSubdomain: string;
  readonly emailFromDomain: string;
  readonly emailFromAddress: string;
  readonly lambda: {
    readonly memoryMb: number;
    readonly architecture: 'arm64' | 'x86_64';
    readonly timeoutSec: number;
    readonly reservedConcurrency: number;
  };
  readonly apiGateway: {
    readonly throttleBurst: number;
    readonly throttleRate: number;
  };
  readonly cognito: {
    readonly mfaTotpEnabled: boolean;
  };
  readonly waf: {
    readonly rateLimitPer5Min: number;
  };
  readonly logRetentionDays: number;
  readonly synthMock: boolean;
}

export const productionConfig: EnvironmentConfig = {
  environment: 'production',
  domainName: 'garageos.aifollyadvisor.com',
  apiSubdomain: 'api',
  appSubdomain: 'app',
  emailFromDomain: 'garageos.aifollyadvisor.com',
  emailFromAddress: 'noreply@garageos.aifollyadvisor.com',
  lambda: {
    memoryMb: 1024,
    architecture: 'arm64',
    timeoutSec: 30,
    reservedConcurrency: 100,
  },
  apiGateway: {
    throttleBurst: 200,
    throttleRate: 100,
  },
  cognito: {
    mfaTotpEnabled: true,
  },
  waf: {
    rateLimitPer5Min: 2000,
  },
  logRetentionDays: 7,
  synthMock: process.env.CDK_SYNTH_MOCK === 'true',
};
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm --filter infrastructure typecheck`
Expected: zero errors.

**Nota:** non committare ancora — Task 4 ha già rotto il build, lo risolveremo in Task 6.

---

### Task 6: Wire MainStack — Storage + WAF + association + outputs + main-stack tests

**Files:**
- Modify: `infrastructure/lib/stacks/main-stack.ts`
- Modify: `infrastructure/tests/main-stack.test.ts`

- [ ] **Step 1: Update MainStack to instantiate Storage, WAF, association, outputs**

Sostituisci interamente `infrastructure/lib/stacks/main-stack.ts` con:

```typescript
import * as cdk from 'aws-cdk-lib';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';

import { ApiGatewayConstruct } from '../constructs/api-gateway.js';
import { CognitoConstruct } from '../constructs/cognito.js';
import { DnsConstruct } from '../constructs/dns.js';
import { LambdaApiConstruct } from '../constructs/lambda-api.js';
import { SecretsConstruct } from '../constructs/secrets.js';
import { StorageConstruct } from '../constructs/storage.js';
import { WafConstruct } from '../constructs/waf.js';
import { type EnvironmentConfig } from '../config/production.js';

// Single production stack hosting the seven constructs shipped through
// PR 23 (DNS, Secrets, Cognito, Storage, Lambda API, API Gateway, WAF).
// Subsequent PRs add SES+Scheduler+Monitoring (PR 24), web app static
// + CloudFront + Cognito Hosted UI (PR 25). Stack-split (NetworkStack +
// ComputeStack) deferred until rollback granularity matters — currently
// tutto-monolitico.

export interface MainStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
}

export class MainStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MainStackProps) {
    super(scope, id, props);

    const { config } = props;

    const dns = new DnsConstruct(this, 'Dns', {
      domainName: config.domainName,
      apiSubdomain: config.apiSubdomain,
      synthMock: config.synthMock,
    });

    const secrets = new SecretsConstruct(this, 'Secrets', {
      environment: config.environment,
    });

    const cognito = new CognitoConstruct(this, 'Cognito', {
      environment: config.environment,
      mfaTotpEnabled: config.cognito.mfaTotpEnabled,
    });

    // Storage construct ships PRIMA del LambdaApi perché LambdaApi
    // consuma il bucket via prop (CDK dep graph order).
    const storage = new StorageConstruct(this, 'Storage', {
      environment: config.environment,
      corsAllowedOrigins: [
        `https://${config.appSubdomain}.${config.domainName}`,
        `https://${config.domainName}`,
      ],
    });

    const lambdaApi = new LambdaApiConstruct(this, 'LambdaApi', {
      memoryMb: config.lambda.memoryMb,
      architecture: config.lambda.architecture,
      timeoutSec: config.lambda.timeoutSec,
      reservedConcurrency: config.lambda.reservedConcurrency,
      logRetentionDays: config.logRetentionDays,
      appSecret: secrets.appSecret,
      officineUserPoolArn: cognito.officineUserPool.userPoolArn,
      clientiUserPoolArn: cognito.clientiUserPool.userPoolArn,
      attachmentsBucket: storage.attachmentsBucket,
    });

    const apiGateway = new ApiGatewayConstruct(this, 'ApiGateway', {
      apiSubdomain: config.apiSubdomain,
      domainName: config.domainName,
      hostedZone: dns.hostedZone,
      apiCertificate: dns.apiCertificate,
      lambdaFunction: lambdaApi.function,
      throttleBurst: config.apiGateway.throttleBurst,
      throttleRate: config.apiGateway.throttleRate,
      logRetentionDays: config.logRetentionDays,
    });

    // WAF + association DOPO ApiGateway perché serve lo stage ARN.
    // Stage ARN format AWS-side: arn:<partition>:apigateway:<region>::
    // /apis/<apiId>/stages/<stageName>. Account section vuota perché
    // apigateway è AWS service ARN (non per-account).
    const waf = new WafConstruct(this, 'Waf', {
      environment: config.environment,
      rateLimitPer5Min: config.waf.rateLimitPer5Min,
    });

    const stageArn = cdk.Stack.of(this).formatArn({
      service: 'apigateway',
      account: '',
      resource: 'apis',
      resourceName: `${apiGateway.httpApi.apiId}/stages/${apiGateway.defaultStage.stageName}`,
      arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
    });

    new wafv2.CfnWebACLAssociation(this, 'WafApiAssociation', {
      resourceArn: stageArn,
      webAclArn: waf.webAcl.attrArn,
    });

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: `https://${config.apiSubdomain}.${config.domainName}`,
    });
    new cdk.CfnOutput(this, 'HttpApiEndpoint', {
      value: apiGateway.httpApi.apiEndpoint,
      description: 'AWS-generated execute-api endpoint (use for smoke before DNS propagation)',
    });
    new cdk.CfnOutput(this, 'LambdaFunctionArn', {
      value: lambdaApi.function.functionArn,
    });
    new cdk.CfnOutput(this, 'AppSecretsArn', {
      value: secrets.appSecret.secretArn,
      description:
        'Pass to `aws secretsmanager update-secret --secret-id` to populate runtime credentials',
    });
    new cdk.CfnOutput(this, 'CognitoOfficineUserPoolId', {
      value: cognito.officineUserPool.userPoolId,
      description: 'Populate into garageos/production/app secret as COGNITO_OFFICINE_POOL_ID',
    });
    new cdk.CfnOutput(this, 'CognitoOfficineClientId', {
      value: cognito.officineClient.userPoolClientId,
      description: 'Populate into garageos/production/app secret as COGNITO_OFFICINE_CLIENT_ID',
    });
    new cdk.CfnOutput(this, 'CognitoClientiUserPoolId', {
      value: cognito.clientiUserPool.userPoolId,
      description: 'Populate into garageos/production/app secret as COGNITO_CLIENTI_POOL_ID',
    });
    new cdk.CfnOutput(this, 'CognitoClientiClientId', {
      value: cognito.clientiClient.userPoolClientId,
      description: 'Populate into garageos/production/app secret as COGNITO_CLIENTI_CLIENT_ID',
    });
    new cdk.CfnOutput(this, 'AttachmentsBucketName', {
      value: storage.attachmentsBucket.bucketName,
      description: 'S3 bucket per allegati intervention/dispute (presigned URL upload F-OFF-305)',
    });
    new cdk.CfnOutput(this, 'WafWebAclArn', {
      value: waf.webAcl.attrArn,
      description: 'WAFv2 Web ACL ARN attached to API Gateway HTTP API v2 default stage',
    });
  }
}
```

- [ ] **Step 2: Add main-stack test extensions**

In `infrastructure/tests/main-stack.test.ts`, trova il `describe('MainStack', ...)` block (l'ultimo) e aggiungi questi 4 test alla fine, PRIMA della chiusura `})` finale del describe:

```typescript
  it('outputs AttachmentsBucketName', () => {
    template.hasOutput('AttachmentsBucketName', {});
  });

  it('outputs WafWebAclArn', () => {
    template.hasOutput('WafWebAclArn', {});
  });

  it('creates a WAF association between the WebACL and the API Gateway default stage', () => {
    // CfnWebACLAssociation expects ResourceArn = API Gateway stage ARN
    // (Fn::Join wrapping apiId + stageName). Match.objectLike +
    // Match.arrayWith perché l'ARN è dynamically constructed via Token.
    template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
    template.hasResourceProperties('AWS::WAFv2::WebACLAssociation', {
      ResourceArn: Match.objectLike({
        'Fn::Join': Match.arrayWith([
          Match.arrayWith([Match.stringLikeRegexp('apigateway')]),
        ]),
      }),
      WebACLArn: Match.anyValue(),
    });
  });

  it('grants the Lambda execution role minimal S3 permissions on the attachments bucket', () => {
    // Verify s3:GetObject + s3:PutObject scoped al bucket arn/*.
    // Action assertion stringent — la grant è raw addToPolicy con
    // exactly 2 actions, niente espansione.
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: ['s3:GetObject', 's3:PutObject'],
          }),
        ]),
      },
    });
  });
```

- [ ] **Step 3: Run all tests**

Run: `pnpm --filter infrastructure test`
Expected: PASS — 31 baseline + 15 storage-waf + 4 nuovi main-stack = 50 totali.

- [ ] **Step 4: Run typecheck**

Run: `pnpm --filter infrastructure typecheck`
Expected: zero errors.

- [ ] **Step 5: Run cdk-synth (synth-mock)**

Run: `pnpm --filter infrastructure cdk-synth`
Expected: zero errors. Synth produce template completo che include `AWS::S3::Bucket`, `AWS::WAFv2::WebACL`, `AWS::WAFv2::WebACLAssociation`, e IAM policy aggiornata.

- [ ] **Step 6: Commit (questo commit chiude la sequenza Task 4/5/6 con build green)**

```bash
git add \
  infrastructure/lib/constructs/lambda-api.ts \
  infrastructure/lib/config/production.ts \
  infrastructure/lib/stacks/main-stack.ts \
  infrastructure/tests/main-stack.test.ts
git commit -m "$(cat <<'EOF'
feat(infra): wire Storage + WAF into MainStack with association

Storage construct istanziato pre-LambdaApi (dep graph), bucket name
passato a LambdaApi come prop. LambdaApi grant raw s3:GetObject +
s3:PutObject scoped a bucket arn/* (no helper L2 grantRead/grantPut
per evitare espansione a List* / Abort*). Env var S3_ATTACHMENTS_BUCKET
per consumo runtime F-OFF-305. WAF construct istanziato post-ApiGateway,
CfnWebACLAssociation creata stack-level via stage ARN format manuale
(formatArn con account vuoto perché apigateway è service ARN). 2
nuovi CfnOutput (AttachmentsBucketName, WafWebAclArn). 4 test
extension main-stack (output presenti, association, S3 grant).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Add F-Storage + F-WAF runbook sections

**Files:**
- Modify: `infrastructure/README.md`

- [ ] **Step 1: Identify insertion point in the runbook**

Apri `infrastructure/README.md` e cerca la sezione **F7.5** (initial admin bootstrap). Le nuove sezioni F-Storage e F-WAF vanno inserite DOPO F7.5 e PRIMA della sezione F8 (se esiste — altrimenti prima del prossimo "header level F-X" successivo).

Run: `grep -n "^## F" infrastructure/README.md`

Per identificare l'ordine sezioni F-N attuale e l'insertion point.

- [ ] **Step 2: Append F-Storage section**

Inserisci la seguente sezione subito dopo il blocco F7.5:

```markdown
## F-Storage. Verifica S3 attachments bucket post-deploy

Dopo il primo deploy che ship-a la `StorageConstruct` (PR 23), valida i 5 punti seguenti dalla shell con AWS CLI configurato per l'account production. Il bucket name è esposto come CfnOutput `AttachmentsBucketName` (anche su SSM ricavabile da CloudFormation describe-stacks).

### F-Storage.a — Bucket esiste

```bash
aws s3api head-bucket --bucket garageos-production-attachments
```

Expected: zero output, exit 0. Failure mode `404 NoSuchBucket` → CDK deploy non è atterrato. `403 Forbidden` → AWS principal manca permission (escalation IAM).

### F-Storage.b — Encryption AES256

```bash
aws s3api get-bucket-encryption --bucket garageos-production-attachments
```

Expected JSON contiene `Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm = "AES256"`.

### F-Storage.c — Versioning enabled

```bash
aws s3api get-bucket-versioning --bucket garageos-production-attachments
```

Expected `{"Status": "Enabled"}`. Non confondere con `MFADelete` (separato, non config-ato in v1).

### F-Storage.d — CORS configurato

```bash
aws s3api get-bucket-cors --bucket garageos-production-attachments
```

Expected JSON con 1 rule: `AllowedMethods: ["GET", "PUT"]`, `AllowedOrigins: ["https://app.garageos.aifollyadvisor.com", "https://garageos.aifollyadvisor.com"]`, `AllowedHeaders: ["*"]`, `MaxAgeSeconds: 3000`.

Failure: se `CORSRule` array vuoto, il CDK deploy non ha applicato la CORS (cd `infrastructure/` && `cdk diff` per check).

### F-Storage.e — Lifecycle rules

```bash
aws s3api get-bucket-lifecycle-configuration --bucket garageos-production-attachments
```

Expected JSON con 2 rule:
1. `Id: "transition-to-ia"`, `Transitions[0]: {Days: 90, StorageClass: "STANDARD_IA"}`, `NoncurrentVersionExpiration: {NoncurrentDays: 30}`.
2. `Id: "abort-incomplete-uploads"`, `AbortIncompleteMultipartUpload: {DaysAfterInitiation: 7}`.

### Failure modes

- **`BucketAlreadyExists`** (deploy time): name `garageos-production-attachments` è globalmente reservato da altro account AWS. Workaround: rinominare in `productionConfig` e re-deploy. Probabilità bassissima (nome semantic specifico al progetto).
- **CORS preflight 403 da browser**: l'origine richiedente non matcha la lista. Verificare che la web app usi esattamente `https://app.garageos.aifollyadvisor.com` (no trailing slash, no `www.`).
- **Lifecycle non scatta visibile**: AWS applica le rule entro ~24h dal trigger event. Per test rapido, set un object con `aws s3api put-object` e check manuale dopo 24h.
- **Versioning impossibile da disabilitare**: una volta enabled, AWS permette solo Suspended (non Off). Decisione consapevole, mantenere Enabled.
```

- [ ] **Step 3: Append F-WAF section**

Subito dopo F-Storage:

```markdown
## F-WAF. Verifica WAF Web ACL + association post-deploy

Dopo il primo deploy che ship-a la `WafConstruct` (PR 23), valida i 4 punti seguenti.

### F-WAF.a — Web ACL esiste

```bash
aws wafv2 list-web-acls --scope REGIONAL --region eu-central-1
```

Expected JSON output contiene un WebACL con `Name: "garageos-production-api-waf"`. Capture il `Id` per il prossimo step.

### F-WAF.b — Association al stage API Gateway

```bash
# Ricava lo stage ARN
API_ID=$(aws apigatewayv2 get-apis --region eu-central-1 \
  --query "Items[?Name=='garageos-api'].ApiId" --output text)
STAGE_ARN="arn:aws:apigateway:eu-central-1::/apis/${API_ID}/stages/\$default"

# Verifica association
aws wafv2 get-web-acl-for-resource --resource-arn "$STAGE_ARN" --region eu-central-1
```

Expected JSON ritorna `WebACL.Name: "garageos-production-api-waf"`. Failure `WAFNonexistentItemException` → association non applicata, controllare CFN events della stack.

### F-WAF.c — CloudWatch metrics attive

```bash
aws cloudwatch list-metrics --namespace AWS/WAFV2 --region eu-central-1 \
  --query "Metrics[?Dimensions[?Value=='garageos-production-api-waf']].MetricName" --output text
```

Expected output contiene almeno: `AllowedRequests`, `BlockedRequests`, `CountedRequests`, `PassedRequests`. Le metric per-rule (`AWSManagedRulesCommonRuleSet`, `AWSManagedRulesKnownBadInputsRuleSet`, `RateLimitIp`) compaiono **solo dopo che la rule è stata triggered almeno una volta**. Per smoke immediato, `AllowedRequests` basta.

### F-WAF.d — Smoke negative test del rate limit (opzionale)

Per validare che il rate limit fa block, simula 3000+ req/5min da single IP a `/health` (rate limit 2000/5min):

```bash
# Da workstation operator
ab -n 3000 -c 100 https://api.garageos.aifollyadvisor.com/health
```

Expected: dopo ~2000 req il WAF inizia a rispondere con `403 Forbidden`. Se TUTTE le 3000 ritornano 200, controllare:
1. Association presente (F-WAF.b)
2. Rule priority 3 con action Block (`aws wafv2 get-web-acl --id <id> --scope REGIONAL --region eu-central-1`)

Smoke opzionale — il rate limit è eventually consistent (sliding window 5min), può richiedere 1-2 minuti di window perché si "saturi".

### Failure modes

- **Association non visibile** post-deploy: stage ARN format errato. AWS richiede `arn:aws:apigateway:<region>::/apis/<apiId>/stages/<stageName>` con account section vuota e `$default` literal (non URL-encoded).
- **Falsi positivi CommonRuleSet** che bloccano traffico legittimo: workaround in CDK aggiungere `excludedRules` alla rule specifica nel `WafConstruct`. Ricognoscere via CloudWatch logs `AWS-WAF-Logs-<region>` (se enabled) o sampled requests in console.
- **Rate limit non kicks in**: il counter è eventually consistent (~30s-2min lag). Per test deterministico, aumentare burst velocemente o ridurre il limit temporaneamente.
- **CLOUDFRONT scope necessario in futuro**: PR 25 (web app + CloudFront) creerà un secondo WAF in us-east-1 — `WafConstruct` come scritto NON è cross-region, dovrà essere parametrizzato o duplicato.
```

- [ ] **Step 4: Run typecheck (no impact, README is markdown)**

Run: `pnpm --filter infrastructure typecheck`
Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
git add infrastructure/README.md
git commit -m "$(cat <<'EOF'
docs(infra): add F-Storage and F-WAF runbook sections

5 smoke commands per attachments bucket post-deploy (head-bucket,
encryption AES256, versioning enabled, CORS 2 origins reali,
lifecycle 2 rule). 4 smoke commands per WAF post-deploy (list-web-acls,
get-web-acl-for-resource, list-metrics, opzionale ab -n 3000 rate
limit smoke). Failure modes documentate: BucketAlreadyExists, CORS
preflight, association ARN format, falsi positivi CommonRuleSet,
CLOUDFRONT scope futuro.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Reconcile APPENDICE_C §5.4 + changelog v1.3

**Files:**
- Modify: `docs/APPENDICE_C_INFRASTRUCTURE.md`

- [ ] **Step 1: Update §5.4 CORS allowedOrigins**

Apri `docs/APPENDICE_C_INFRASTRUCTURE.md`, cerca la sezione `### 5.4 Construct: Storage` e dentro il code block trova:

```typescript
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT],
          allowedOrigins: ['https://app.garageos.it', 'https://garageos.it'],
          allowedHeaders: ['*'],
          maxAge: 3000,
        },
      ],
```

Sostituisci con:

```typescript
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT],
          allowedOrigins: [
            'https://app.garageos.aifollyadvisor.com',
            'https://garageos.aifollyadvisor.com',
          ],
          allowedHeaders: ['*'],
          maxAge: 3000,
        },
      ],
```

Aggiungi questa nota narrativa subito dopo il code block (prima della §5.5):

```markdown
**Nota retrospettiva (v1.3, 2026-05-04)**: la versione iniziale di questo construct citava `garageos.it` come dominio CORS. Il dominio reale acquisito è `garageos.aifollyadvisor.com` (vedi §7.1) — gli `allowedOrigins` sono allineati di conseguenza. Il bucket name resta `garageos-${environment}-attachments` (stringa semantic, indipendente dal dominio).
```

- [ ] **Step 2: Add changelog v1.3 row**

Cerca la sezione `### 1.3 Changelog`. Aggiungi UNA RIGA in cima alla tabella (sopra v1.2):

```markdown
| **v1.3** | 2026-05-04 | PR 23 ship-a Storage (S3 attachments bucket) e WAF (REGIONAL Web ACL) construct in `GarageosMainStack`. §5.4 CORS `allowedOrigins` riconciliato a `garageos.aifollyadvisor.com` (dominio reale acquisito post-spec). §5.8 confermato REGIONAL scope per API Gateway HTTP API v2; CLOUDFRONT scope deferred a PR 25 (web app static + CloudFront). Lambda execution role grant pre-emptive `s3:GetObject` + `s3:PutObject` scoped al bucket arn/* (raw policy statement, no L2 helper grantRead/grantPut). Env var Lambda `S3_ATTACHMENTS_BUCKET` per consumo F-OFF-305 (PR successivo). Tag PDF bucket deferred fino a F-OFF-104/109 ship. |
```

- [ ] **Step 3: Update §5.8 WAF section with REGIONAL scope confirmation**

Cerca la sezione `### 5.8 Construct: WAF`. PRIMA del code block, aggiungi questa nota:

```markdown
**Nota implementativa (v1.3)**: Il `WafConstruct` in PR 23 ship-a con `scope: 'REGIONAL'` literal (non parametrizzato come nel template originale `'REGIONAL' | 'CLOUDFRONT'`) — è attached al stage default di API Gateway HTTP API v2 in eu-central-1. Quando arriverà PR 25 (web app static + CloudFront), un secondo WAF dedicato verrà ship-ato in scope CLOUDFRONT (richiede deployment in us-east-1 — cross-region). Il template dell'interface `WafProps` resta come riferimento per il design futuro multi-scope, ma il construct concreto attuale è specializzato per REGIONAL.
```

- [ ] **Step 4: Verify markdown linting (Prettier auto-format on commit hook)**

Il husky pre-commit hook esegue prettier su markdown. Niente di manuale da fare.

- [ ] **Step 5: Commit**

```bash
git add docs/APPENDICE_C_INFRASTRUCTURE.md
git commit -m "$(cat <<'EOF'
docs: reconcile APPENDICE_C §5.4 CORS origins to real domain

§5.4 allowedOrigins aggiornati da garageos.it letterale a
garageos.aifollyadvisor.com (dominio reale acquisito post-spec).
§5.8 nota implementativa: WafConstruct PR 23 ship-a REGIONAL only,
CLOUDFRONT scope deferred a PR 25. Changelog v1.3 row con scope
completo della PR 23.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Final Verification

Dopo Task 8, eseguire la full verification suite locale:

- [ ] **Final Step 1: Typecheck workspace-wide**

Run: `pnpm -r typecheck`
Expected: zero errors across api, database, infrastructure, shared.

- [ ] **Final Step 2: Infrastructure tests full suite**

Run: `pnpm --filter infrastructure test`
Expected: ~50 test passing (31 baseline + 15 storage-waf + 4 main-stack ext).

- [ ] **Final Step 3: CDK synth-mock validation**

Run: `pnpm --filter infrastructure cdk-synth`
Expected: zero errors. Output template (`cdk.out/GarageosMainStack.template.json`) contiene:
- 1 `AWS::S3::Bucket`
- 1 `AWS::WAFv2::WebACL`
- 1 `AWS::WAFv2::WebACLAssociation`
- IAM policy con `Action: ['s3:GetObject', 's3:PutObject']`
- Output `AttachmentsBucketName`, `WafWebAclArn`
- Lambda environment con `S3_ATTACHMENTS_BUCKET`

- [ ] **Final Step 4: PR size check**

Run: `git diff main --stat`
Expected: ~500-700 righe modificate net, ben sotto soglia 1200/1500.

- [ ] **Final Step 5: Push branch + open PR**

```bash
git push -u origin feat/cdk-storage-waf
gh pr create --title "feat(infra): PR 23 storage (S3 attachments) + WAF (REGIONAL)" --body "$(cat <<'EOF'
## What

Aggiunge `StorageConstruct` (S3 attachments bucket) e `WafConstruct`
(REGIONAL Web ACL) a `GarageosMainStack`, con WAF association al
default stage di API Gateway, IAM grant pre-emptive (`s3:GetObject`
+ `s3:PutObject`) sulla Lambda execution role, env var
`S3_ATTACHMENTS_BUCKET` runtime.

## Why

PR 23 della roadmap infra (vedi commento header `main-stack.ts:11-13`).
Sblocca F-OFF-305 (presigned upload endpoint) + dispute attachments
tech debt. Spec: `docs/superpowers/specs/2026-05-04-cdk-storage-waf-design.md`.

## Implementation notes

- 2 nuovi construct paralleli al pattern esistente (Cognito/LambdaApi/ApiGateway).
- Storage instanziato pre-LambdaApi (dep graph). WAF + association post-ApiGateway.
- IAM grant raw `addToPolicy` (no `grantRead`/`grantPut` L2 helper) per ottenere action set minimo `[s3:GetObject, s3:PutObject]` — gli helper espandono a `s3:List*` / `s3:Abort*` / etc.
- WAF association via `CfnWebACLAssociation` L1 stack-level (no L2 wrapper esiste); stage ARN format manuale via `formatArn` con account section vuota (apigateway è AWS service ARN).
- APPENDICE_C §5.4 riconciliato: CORS origins reali `garageos.aifollyadvisor.com`. Changelog v1.3.

## Out of scope

- CloudFront (PR 25)
- Tag PDF bucket (deferred fino F-OFF-104/109)
- F-OFF-305 endpoint code in `packages/api/` (PR successivo)
- WAF CLOUDFRONT scope (sblocca con CloudFront in PR 25)

## Tests

- [x] 8 unit test StorageConstruct (`storage-waf.test.ts`)
- [x] 7 unit test WafConstruct (`storage-waf.test.ts`)
- [x] 4 main-stack extension test (output, association, S3 grant)
- [x] CDK synth-mock validation green
- [x] Manual smoke documented in `infrastructure/README.md` §F-Storage + §F-WAF post-deploy

## Checklist

- [x] Code follows conventions in CONTRIBUTING.md
- [x] Types compile (`pnpm typecheck`)
- [x] Tests pass (`pnpm --filter infrastructure test`)
- [x] No new `console.log`, no commented-out code
- [x] Secrets not committed
- [x] Documentation updated (APPENDICE_C §5.4 + §5.8 nota + changelog v1.3, README.md F-Storage + F-WAF)
EOF
)"
```

---

## Self-Review

Spec coverage check (mapping each spec section to a task):

| Spec section | Task |
|---|---|
| 3.1 Layout file modificati / creati | Tutti i task (1-8) coprono 1+ file ciascuno |
| 3.2 StorageConstruct shape | Task 1 |
| 3.3 WafConstruct shape | Task 2 |
| 3.4 LambdaApiConstruct modifications | Task 4 |
| 3.5 ApiGatewayConstruct modifications | Task 3 |
| 3.6 MainStack wiring | Task 6 |
| 3.7 productionConfig extension | Task 5 |
| 4 Decisioni esplicite (Q1-Q4 + D1-D4) | Tutti applicate nei code block dei task |
| 5.1 Test storage-waf.test.ts | Task 1 + Task 2 |
| 5.2 Test main-stack extension | Task 6 |
| 5.3 CI gate | Final Verification |
| 5.4 Smoke post-deploy | Task 7 (runbook) |
| 6 Runbook updates | Task 7 |
| 7 Tech debt | Documentato in spec; non require code change in PR 23 |
| 8 Stima dimensioni PR | Final Verification step 4 |
| 9 Rischi | Affrontati nei test + synth check |
| 10 Ordine commit | Task 1-8 → 8 commit + 1 squash |

Tutte le sezioni dello spec hanno copertura. Nessun gap.

Type/method consistency check:

- `StorageConstructProps`: `environment: string`, `corsAllowedOrigins: readonly string[]` — coerente Task 1 + Task 6.
- `attachmentsBucket: s3.Bucket` (Storage) → `attachmentsBucket: s3.IBucket` (LambdaApi prop) — interface assignable, OK.
- `WafConstructProps`: `environment: string`, `rateLimitPer5Min: number` — coerente Task 2 + Task 6.
- `WafConstruct.webAcl: wafv2.CfnWebACL` → consumed via `.attrArn` — OK.
- `ApiGatewayConstruct.defaultStage: apigw.IStage` (Task 3) → consumed via `.stageName` (Task 6) — OK (`IStage` espone `stageName`).
- Test helper `buildTemplate()` ha return type `Template` esplicito — coerente Task 1 + Task 2.

Placeholder scan: nessuno. Tutti i code block sono completi, tutti i path file sono assoluti relativi al repo root, tutti i comandi shell hanno expected output documentato.
