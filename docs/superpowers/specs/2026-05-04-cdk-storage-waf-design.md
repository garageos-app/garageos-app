# PR 23 — Storage (S3 attachments) + WAF (REGIONAL)

**Data:** 2026-05-04
**Stato:** spec
**Spec parent:** `docs/APPENDICE_C_INFRASTRUCTURE.md` §1.2, §5.4, §5.8
**PR sequence:** PR 22 (Cognito, MERGED #31) → PR 23 (questo) → PR 24 (SES+Scheduler+Monitoring) → PR 25 (web app S3 + CloudFront + Cognito Hosted UI)

---

## 1. Obiettivo

Aggiungere allo `GarageosMainStack` due nuovi construct CDK:

1. **`StorageConstruct`** — un bucket S3 `garageos-production-attachments` per upload/download di allegati (foto/PDF/video) ai workflow di intervention create, dispute e — in futuro — dispute-response. Lifecycle, CORS e versioning come da spec §5.4.
2. **`WafConstruct`** — un Web ACL WAFv2 scope `REGIONAL` con le 3 rule di spec §5.8 (CommonRuleSet, KnownBadInputs, RateLimit IP 2000/5min) + association al default stage dell'HTTP API v2 esistente.

In aggiunta:
- IAM grant pre-emptive sulla Lambda execution role per `s3:PutObject` + `s3:GetObject` scoped a `<bucket-arn>/*` (mirror del pattern PR #31 Cognito grant).
- `CfnOutput` `AttachmentsBucketName` per visibilità operatore.
- Update runbook `infrastructure/README.md` con nuova sezione F-Storage e F-WAF.

PR 23 è **infra-only**: sblocca F-OFF-305 (presigned URL upload) ma **non** ship-a alcun endpoint API o code change in `packages/api/`. Quegli arrivano in PR successivo dedicato dopo che il bucket è live.

**Non in scope (deferred):**
- CloudFront construct (PR 25 — coupled con S3 web app static).
- Tag PDF bucket `garageos-production-tags` (deferred a quando F-OFF-104/109 ship-a, evita lifecycle non testato).
- API endpoint `POST /v1/attachments/upload-url` (PR successivo dedicato F-OFF-305).
- `AttachmentOwnerType` schema extension per dispute (PR F-OFF-305 + dispute follow-up).
- WAF CLOUDFRONT scope (sblocca con CloudFront in PR 25).
- Sentry/CloudWatch alarms (PR 24).
- `s3:DeleteObject` sulla execution role (lifecycle policy gestisce noncurrent versions + multipart uploads aborted).
- `s3:ListBucket` (non serve oggi; wider-than-needed grant).

## 2. Contesto e prerequisiti

**Stato di partenza (post merge PR #48 al 2026-05-04):**
- `main` HEAD `259402e`. Working tree pulito salvo `docs/superpowers/{plans,specs}/` untracked (pattern stabilito).
- `infrastructure/` workspace con 5 construct (DNS, Secrets, Cognito, LambdaApi, ApiGateway) + 2 stack (Oidc, Main). 31/31 assertion test green (19 baseline + 12 Cognito).
- `MainStack` header commento (line 11-13) cita esplicitamente: `"Subsequent PRs add Storage+WAF (PR 23), SES+Scheduler+Monitoring (PR 24)"` — questo PR materializza la prima delle due aggiunte.
- `LambdaApiConstruct` execution role grants oggi: `secretsmanager:GetSecretValue` (PR 21) + 4 `cognito-idp:Admin*` actions scoped pool ARN (PR 31). Zero S3 grant.
- `productionConfig` ha `appSubdomain: 'app'`, `domainName: 'garageos.aifollyadvisor.com'` — CORS allowedOrigins useranno `https://app.garageos.aifollyadvisor.com` + `https://garageos.aifollyadvisor.com` (allineamento al dominio reale, non `garageos.it` come da spec §5.4 letterale).
- `ApiGatewayConstruct.httpApi.defaultStage` esiste; lo stage ARN non è oggi esposto ma è derivabile via `httpApi.apiId` + `defaultStage.stageName`.
- API code base: ZERO chiamate `s3:*` SDK, ZERO import `@aws-sdk/client-s3`. La PR successiva F-OFF-305 li introdurrà.

**Vincoli:**
- Hard limit 1500 righe diff (alert 1200). Stima PR 23 = ~500-700 righe ben dentro.
- `removalPolicy: RETAIN` obbligatorio sul bucket attachments (stateful — perdere il bucket = perdere tutti gli allegati di tutti gli workshop).
- `BlockPublicAccess.BLOCK_ALL` obbligatorio (no public S3 — accesso solo via presigned URL).
- Niente nomi bucket / pool ARN / ID in chat o git.
- Nessun deploy eseguito da Claude. Auto-deploy production triggerato dal merge tramite path filter `infrastructure/**` (PR #46+#47). L'operatore può approvare il required reviewer gate "production" sul workflow `Deploy`.
- **Stack-split deferred** (vedi `main-stack.ts:11-13`): tutto resta in `GarageosMainStack`.

## 3. Architettura

### 3.1 Layout file modificati / creati

```
infrastructure/
├── lib/
│   ├── constructs/
│   │   ├── storage.ts              # NEW — StorageConstruct (~80 righe)
│   │   ├── waf.ts                  # NEW — WafConstruct (~120 righe)
│   │   ├── api-gateway.ts          # MODIFIED — espone defaultStage per WAF association (~5 righe)
│   │   └── lambda-api.ts           # MODIFIED — accetta attachmentsBucket prop, grant Get+Put (~15 righe)
│   └── stacks/
│       └── main-stack.ts           # MODIFIED — instanzia Storage+WAF, wira IAM, crea CfnWebACLAssociation, +CfnOutput (~40 righe)
├── tests/
│   ├── storage-waf.test.ts         # NEW — assertion test sui 2 nuovi construct + association (~150 righe)
│   └── main-stack.test.ts          # MODIFIED — +6-8 expect (Storage CfnOutput, WAF association, S3 grant, bucket props) (~30 righe)
└── README.md                       # MODIFIED — nuova §F-Storage + §F-WAF nel runbook (~80 righe)

docs/
└── APPENDICE_C_INFRASTRUCTURE.md   # MODIFIED — riconciliazione §5.4 (CORS allowedOrigins reali) + §5.8 (REGIONAL scope confermato) + new changelog row (~20 righe)
```

Niente nuove sub-stack. Niente nuovi workspace o package.

### 3.2 `StorageConstruct` shape

```typescript
// infrastructure/lib/constructs/storage.ts (sketch — non finale)
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface StorageConstructProps {
  readonly environment: string;       // 'production'
  readonly corsAllowedOrigins: readonly string[];  // ['https://app.<domain>', 'https://<domain>']
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
          transitions: [{
            storageClass: s3.StorageClass.INFREQUENT_ACCESS,
            transitionAfter: cdk.Duration.days(90),
          }],
          noncurrentVersionExpiration: cdk.Duration.days(30),
        },
        {
          id: 'abort-incomplete-uploads',
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
      ],
      cors: [{
        allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT],
        allowedOrigins: [...props.corsAllowedOrigins],
        allowedHeaders: ['*'],
        maxAge: 3000,
      }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
  }
}
```

**Note di implementazione:**
- `bucketName` esplicito perché serve essere noto a deploy time (presigned URL signing nel codice api userà il nome). Conseguenza: bucket name globally unique a livello AWS — `garageos-production-attachments` collision-check fatto via `aws s3api head-bucket` pre-deploy nel runbook.
- `versioned: true` per protezione contro overwrite accidentali / ransomware. Costo: doppio storage temporaneo finché il lifecycle non scade le noncurrent versions a 30 giorni.
- `lifecycleRules` letterale dalla spec §5.4. Transition a IA dopo 90gg riduce costi (~40% storage cost) per allegati storici raramente acceduti.
- `cors.allowedHeaders: ['*']` permissivo — accettabile perché PUT è autenticato via presigned URL pre-firmato (no spoofing). `maxAge: 3000` = 50min cache preflight.
- `removalPolicy: RETAIN` blocca `cdk destroy` da cancellare il bucket. Cleanup manuale solo via console se necessario (es. tear-down ambienti staging — ma staging non esiste in v1).

### 3.3 `WafConstruct` shape

```typescript
// infrastructure/lib/constructs/waf.ts (sketch — non finale)
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';

export interface WafConstructProps {
  readonly environment: string;       // 'production'
  readonly rateLimitPer5Min: number;  // 2000 (spec §5.8)
}

export class WafConstruct extends Construct {
  public readonly webAcl: wafv2.CfnWebACL;

  constructor(scope: Construct, id: string, props: WafConstructProps) {
    super(scope, id);

    this.webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      name: `garageos-${props.environment}-api-waf`,
      scope: 'REGIONAL',  // attached to API Gateway HTTP API v2 (REGIONAL endpoint)
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        sampledRequestsEnabled: true,
        metricName: 'GarageosWaf',  // matches APPENDICE_C §5.8 letterale
      },
      rules: [
        {
          name: 'AWS-ManagedRulesCommonRuleSet',
          priority: 1,
          overrideAction: { none: {} },
          statement: { managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesCommonRuleSet' } },
          visibilityConfig: { cloudWatchMetricsEnabled: true, sampledRequestsEnabled: true, metricName: 'AWSManagedRulesCommonRuleSet' },
        },
        {
          name: 'AWS-ManagedRulesKnownBadInputsRuleSet',
          priority: 2,
          overrideAction: { none: {} },
          statement: { managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesKnownBadInputsRuleSet' } },
          visibilityConfig: { cloudWatchMetricsEnabled: true, sampledRequestsEnabled: true, metricName: 'AWSManagedRulesKnownBadInputsRuleSet' },
        },
        {
          name: 'RateLimitIp',
          priority: 3,
          action: { block: {} },
          statement: { rateBasedStatement: { limit: props.rateLimitPer5Min, aggregateKeyType: 'IP' } },
          visibilityConfig: { cloudWatchMetricsEnabled: true, sampledRequestsEnabled: true, metricName: 'RateLimitIp' },
        },
      ],
    });
  }
}
```

**Note di implementazione:**
- Costruct espone solo `webAcl`. Il `CfnWebACLAssociation` è creato in `MainStack` perché la composition richiede sia l'ACL ARN che lo stage ARN (cross-construct), e mantiene il single-responsibility delle classi.
- `scope: 'REGIONAL'` literal — per API Gateway. CLOUDFRONT scope arriverà in PR 25 (separato; CLOUDFRONT WAF deve vivere in us-east-1, cross-region).
- `defaultAction: allow` + 3 rule deny-on-match. Match logic: CommonRuleSet/KnownBadInputs per OWASP/exploit signature, RateLimitIp per dos/brute-force.
- `rateLimitPer5Min: 2000` da spec §5.8. Hardcoded 2000 nel construct va male per testabilità — esposto come prop con default `productionConfig.waf.rateLimitPer5Min = 2000`.
- `name` esplicito per identificazione console/API. CloudWatch `metricName` distinti per analisi separata.

### 3.4 `LambdaApiConstruct` modifications

Aggiungere prop e grant. Diff sketch:

```typescript
// infrastructure/lib/constructs/lambda-api.ts (modifications)
import * as s3 from 'aws-cdk-lib/aws-s3';

export interface LambdaApiConstructProps {
  // ... existing fields ...
  readonly attachmentsBucket: s3.IBucket;  // NEW — pre-emptive grant
}

// In constructor, after existing cognito grant — minimal grant via raw policy
// (grantRead/grantPut helpers di CDK espandono a action set più largo del
// necessario: grantRead include `s3:List*` + `s3:GetBucket*`; grantPut
// include `s3:Abort*` + `s3:PutObjectLegalHold` + `s3:PutObjectRetention`
// + `s3:PutObjectTagging`. Per Q4 = "minimale" preferiamo statement esplicito).
executionRole.addToPolicy(
  new iam.PolicyStatement({
    actions: ['s3:GetObject', 's3:PutObject'],
    resources: [`${props.attachmentsBucket.bucketArn}/*`],
  }),
);

// Bucket name esposto al runtime via env var (non-secret).
// Il PR F-OFF-305 successivo lo legge per signing presigned URL.
// (aggiunto a this.function.addEnvironment('S3_ATTACHMENTS_BUCKET', ...))
```

**Note di implementazione:**
- Uso `addToPolicy` raw con action set minimo `['s3:GetObject', 's3:PutObject']` invece dei helper L2 `grantRead`/`grantPut`. Razionale: l'helper `grantRead` espande a `['s3:GetObject*', 's3:GetBucket*', 's3:List*']`, includendo `s3:ListBucket` esplicitamente escluso da Q4. Il path raw garantisce la decisione "minimale" presa.
- `bucketArn + '/*'` scoping all'object level (non bucket level): il Lambda non può fare bucket-level operations come `ListBucket` o `GetBucketLocation`.
- Header comment del construct (line 41-46) già anticipa il pattern: "S3 / Cognito / SES / Scheduler permissions arrive in subsequent PRs together with the construct that needs them." — questo PR materializza S3.
- Granted prima dell'endpoint F-OFF-305 (mirror PR #31 Cognito pattern). Tech debt entry "Pre-emptive S3 IAM grant" verrà aperto in `project_tech_debt.md` con priority `very-low` — review pattern dopo F-OFF-305 ship (ridimensionare action list o conferma).
- Env var `S3_ATTACHMENTS_BUCKET` aggiunta al Lambda environment (mirror del pattern `APP_SECRETS_ARN`/`NODE_EXTRA_CA_CERTS` esistenti). Il bucket name non è secret — esposto in CfnOutput.

### 3.5 `ApiGatewayConstruct` modifications

Esposizione del default stage per WAF association. Diff sketch:

```typescript
// infrastructure/lib/constructs/api-gateway.ts (modifications)

export class ApiGatewayConstruct extends Construct {
  public readonly httpApi: apigw.HttpApi;
  public readonly domainName: apigw.DomainName;
  public readonly accessLogGroup: logs.LogGroup;
  public readonly defaultStage: apigw.IStage;  // NEW — exposed for WAF association

  constructor(scope: Construct, id: string, props: ApiGatewayConstructProps) {
    super(scope, id);
    // ... existing logic ...
    this.defaultStage = this.httpApi.defaultStage!;  // assigned after addRoutes
    // ... rest unchanged ...
  }
}
```

**Note di implementazione:**
- `this.httpApi.defaultStage` è già accessibile internamente (line 99 del file attuale fa `this.httpApi.defaultStage?.node.defaultChild as apigw.CfnStage`). Esponiamo come public readonly per consumo dal MainStack.
- Non-null assertion: `httpApi.defaultStage` è sempre populated dopo `addRoutes` in HTTP API v2; il `?` esistente è difensivo ma non necessario in pratica.

### 3.6 `MainStack` wiring

Aggiunta delle 2 instanziazioni + association + output. Diff sketch:

```typescript
// infrastructure/lib/stacks/main-stack.ts (modifications)
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { StorageConstruct } from '../constructs/storage.js';
import { WafConstruct } from '../constructs/waf.js';

// Inside constructor, BEFORE LambdaApiConstruct:
const storage = new StorageConstruct(this, 'Storage', {
  environment: config.environment,
  corsAllowedOrigins: [
    `https://${config.appSubdomain}.${config.domainName}`,
    `https://${config.domainName}`,
  ],
});

// LambdaApiConstruct now receives attachmentsBucket:
const lambdaApi = new LambdaApiConstruct(this, 'LambdaApi', {
  // ... existing props ...
  attachmentsBucket: storage.attachmentsBucket,
});

// AFTER apiGateway construct:
const waf = new WafConstruct(this, 'Waf', {
  environment: config.environment,
  rateLimitPer5Min: config.waf.rateLimitPer5Min,
});

// Stage ARN format for HTTP API v2:
// arn:aws:apigateway:<region>::/apis/<apiId>/stages/<stageName>
const stageArn = cdk.Stack.of(this).formatArn({
  service: 'apigateway',
  account: '',  // AWS service ARN — no account
  resource: 'apis',
  resourceName: `${apiGateway.httpApi.apiId}/stages/${apiGateway.defaultStage.stageName}`,
  arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
});

new wafv2.CfnWebACLAssociation(this, 'WafApiAssociation', {
  resourceArn: stageArn,
  webAclArn: waf.webAcl.attrArn,
});

// CfnOutput:
new cdk.CfnOutput(this, 'AttachmentsBucketName', {
  value: storage.attachmentsBucket.bucketName,
  description: 'S3 bucket per allegati intervention/dispute (presigned URL upload)',
});
new cdk.CfnOutput(this, 'WafWebAclArn', {
  value: waf.webAcl.attrArn,
  description: 'WAFv2 Web ACL ARN attached to API Gateway HTTP API v2 default stage',
});
```

**Note di implementazione:**
- Storage construct creato PRIMA di LambdaApi perché LambdaApi consuma il bucket via prop. Order matters per CDK dep graph.
- WAF association creato come standalone `CfnWebACLAssociation` direttamente nel stack (non incapsulato in WafConstruct) — single responsibility.
- Stage ARN formattato manualmente perché `apigatewayv2 IStage` non espone uno helper `stageArn`. Format documented AWS-side: `arn:aws:apigateway:<region>::/apis/<apiId>/stages/<stageName>`. Le 4 parti sono populated da L2.
- `appSubdomain: 'app'` + `domainName: 'garageos.aifollyadvisor.com'` di config → `'https://app.garageos.aifollyadvisor.com'` + `'https://garageos.aifollyadvisor.com'`.

### 3.7 `productionConfig` extension

Aggiungere sub-config WAF:

```typescript
// infrastructure/lib/config/production.ts
export interface EnvironmentConfig {
  // ... existing fields ...
  readonly waf: {
    readonly rateLimitPer5Min: number;
  };
}

export const productionConfig: EnvironmentConfig = {
  // ... existing ...
  waf: {
    rateLimitPer5Min: 2000,
  },
};
```

## 4. Decisioni esplicite

Decisioni prese durante brainstorming (Q1-Q4) + default applicati:

| ID | Decisione | Rationale |
|---|---|---|
| Q1 | **CloudFront deferred a PR 25** | YAGNI; oggi nessun consumer (web app non esiste); CloudFront cross-region (cert us-east-1) raddoppia complessità senza payoff immediato. |
| Q2 | **Tag PDF bucket deferred** | Endpoint F-OFF-104/109 non ship-ato; lifecycle non testato sarebbe debt. Aggiungere bucket `tags` quando first endpoint lo userà. |
| Q3 | **WAF rules: 3 di spec §5.8 verbatim** | No layer aggiuntivo (IpReputationList, geo-block) — aderire alla spec. Future hardening separato e misurato. |
| Q4 | **IAM grant pre-emptive minimale** (`s3:PutObject` + `s3:GetObject`) | Mirror pattern PR #31 Cognito. DELETE coperto da lifecycle policy; ListBucket non serve oggi. Tight ARN scope. |
| D1 | **CORS allowedOrigins reali** (`garageos.aifollyadvisor.com`, non `garageos.it` letterale spec) | Spec §5.4 era pre-domain-acquisition. APPENDICE_C va riconciliato in this PR (changelog row). |
| D2 | **Bucket name `garageos-production-attachments`** | Template `garageos-${environment}-attachments` di spec §5.4. |
| D3 | **WAF association via `CfnWebACLAssociation` raw L1 in MainStack** | L2 wrapper non esiste in CDK; L1 è il cammino standard. Composition stack-level, non construct-level. |
| D4 | **Test file singolo `storage-waf.test.ts`** | Mirror del pattern `cognito.test.ts` (1 file per construct cluster); le 2 entità sono aggiunte insieme nello stesso PR e logicamente accoppiate. |

## 5. Test plan

### 5.1 Test unit `infrastructure/tests/storage-waf.test.ts` (~150 righe)

**StorageConstruct:**
- `provisions exactly one S3 bucket with the expected name` — `template.resourceCountIs('AWS::S3::Bucket', 1)` + `BucketName: 'garageos-production-attachments'`.
- `enforces server-side encryption (S3-managed)` — match `BucketEncryption.ServerSideEncryptionConfiguration[0].ServerSideEncryptionByDefault.SSEAlgorithm: 'AES256'`.
- `blocks all public access` — `PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true }`.
- `enables versioning` — `VersioningConfiguration.Status: 'Enabled'`.
- `configures CORS for app + apex origins` — `CorsConfiguration.CorsRules[0].AllowedOrigins: ['https://app.garageos.aifollyadvisor.com', 'https://garageos.aifollyadvisor.com']` + methods GET+PUT.
- `configures lifecycle rule: transition-to-ia after 90 days` — match Rule with `Id: 'transition-to-ia'` + `Transitions[0].StorageClass: 'STANDARD_IA'` + `TransitionInDays: 90`.
- `configures lifecycle rule: abort incomplete uploads after 7 days` — Rule with `AbortIncompleteMultipartUpload.DaysAfterInitiation: 7`.
- `expires noncurrent versions after 30 days` — Rule with `NoncurrentVersionExpiration.NoncurrentDays: 30`.
- `retains bucket on stack deletion` — `template.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' })`.

**WafConstruct:**
- `provisions exactly one Web ACL with REGIONAL scope` — `WebACL.Scope: 'REGIONAL'`.
- `default action is allow` — `WebACL.DefaultAction.Allow: {}`.
- `provisions 3 rules with expected priorities and names` — array length 3 + names + priorities.
- `applies AWS managed CommonRuleSet` — match Rule[0] with `ManagedRuleGroupStatement.{VendorName: 'AWS', Name: 'AWSManagedRulesCommonRuleSet'}`.
- `applies AWS managed KnownBadInputs` — analogo.
- `rate-limits to 2000 requests per 5min per IP` — Rule[2] with `RateBasedStatement.Limit: 2000` + `AggregateKeyType: 'IP'` + `Action.Block: {}`.
- `enables CloudWatch metrics for ACL and each rule` — `VisibilityConfig.CloudWatchMetricsEnabled: true` su ACL e tutte e 3 le rules.

### 5.2 Test extension in `main-stack.test.ts` (+6-8 expect, ~30 righe)

- `outputs AttachmentsBucketName` — `template.hasOutput('AttachmentsBucketName', {...})`.
- `outputs WafWebAclArn` — analogo.
- `creates a WAF association between the WebACL and the API Gateway default stage` — `template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1)` + `ResourceArn` con `Fn::Join` matching API Gateway stage ARN pattern.
- `Lambda execution role has S3 GetObject + PutObject permissions scoped to attachments bucket` — IAM PolicyDocument contiene Statement con Action=['s3:GetObject*', 's3:PutObject*', ...] scoped al bucket ARN (CDK `grantRead`+`grantPut` aggiungono action sets specifici, validare con `Match.arrayWith`).

**Nota:** assertion CDK su action lists generate da `grantRead`/`grantPut` deve essere flessibile — la libreria può espandere a list più ampia di quella minimale (es. `s3:GetObject*` invece di `s3:GetObject`). Usare `Match.arrayWith` con subset assertion.

### 5.3 CI gate
- `pnpm --filter infrastructure typecheck` — pre-push hook locale.
- `pnpm --filter infrastructure test` — CI Vitest (passa da 31 a ~50-54 test totali: 16 storage-waf + 4-8 main-stack extension).
- `pnpm --filter infrastructure cdk-synth` — CI synth-mock validation (zero errori).
- `pnpm test:unit` — packages api/database invariati (no code change there).

### 5.4 Smoke post-deploy (operator-driven, runbook)

Nel runbook README §F-Storage:
1. Verifica bucket esiste: `aws s3api head-bucket --bucket garageos-production-attachments`.
2. Verifica encryption: `aws s3api get-bucket-encryption --bucket garageos-production-attachments` → SSE AES256.
3. Verifica versioning: `aws s3api get-bucket-versioning --bucket garageos-production-attachments` → Status: Enabled.
4. Verifica CORS: `aws s3api get-bucket-cors --bucket garageos-production-attachments` → 2 origins + GET/PUT.
5. Verifica lifecycle: `aws s3api get-bucket-lifecycle-configuration --bucket garageos-production-attachments` → 2 rules.

Nel runbook README §F-WAF:
1. Verifica Web ACL esiste: `aws wafv2 list-web-acls --scope REGIONAL --region eu-central-1` → contiene `garageos-production-api-waf`.
2. Verifica association: `aws wafv2 get-web-acl-for-resource --resource-arn <stageArn> --region eu-central-1` → ritorna l'ACL ID.
3. CloudWatch metrics check: `aws cloudwatch list-metrics --namespace AWS/WAFV2 --region eu-central-1` → metric `GarageosApiWaf`/`CommonRuleSet`/`KnownBadInputs`/`RateLimitIp`.
4. Smoke negative: 100+ rapid GET burst da single IP a `/health` → eventually 403 quando rate limit kicks (non sostituibile via curl scriptato pulito; manual test con `ab -n 3000 -c 100` opzionale).

## 6. Runbook updates (`infrastructure/README.md`)

**Nuovo §F-Storage** (post §F7.5):
- Cosa ship-a (1 bucket retain + lifecycle + CORS).
- Smoke commands sopra.
- Failure modes:
  - `BucketAlreadyExists` (nome globalmente reservato) → escalation manuale (rare).
  - CORS preflight 403 da browser → check origins array.
  - Lifecycle non scatta → AWS lo applica entro 24h del trigger.

**Nuovo §F-WAF**:
- Cosa ship-a (1 Web ACL REGIONAL + association al stage).
- Smoke commands sopra.
- Failure modes:
  - Association non visibile → check stage ARN format (eu-central-1, no account in ARN).
  - Falsi positivi CommonRuleSet bloccano richieste legittime → workaround `excluded_rules` per rule specifica (post-deploy iterativo).
  - Rate limit bug-prone → contatore 5-min sliding, eventually consistent.

**Update §F10 path filter table** (referenziato in PR #46):
- Aggiungi nota che `infrastructure/lib/constructs/storage.ts` e `waf.ts` triggerano deploy automatico (path filter `infrastructure/**` già coperto).

## 7. Tech debt e follow-up

### 7.1 Aperto in PR 23

| Voce | Priority | Quando chiuderlo |
|---|---|---|
| **Pre-emptive S3 IAM grant** (`s3:PutObject` + `s3:GetObject` su attachments bucket, granted prima di F-OFF-305 endpoint) | very-low | Review post F-OFF-305 ship: confermare action list rimasta minima oppure ridimensionare. Stesso pattern del cleanup PR #31 Cognito grant pre-emptive. |
| **Tag PDF bucket non ship-ato** | low | Quando F-OFF-104/109 (tag.pdf endpoint) ship — nuovo construct `TagsStorageConstruct` o estensione di `StorageConstruct` con secondo bucket. |
| **CloudFront construct + CLOUDFRONT WAF** | medium | PR 25 (web app S3 + CloudFront). Cross-region (us-east-1 cert), nuovo stack o nested stack. |

### 7.2 Risolti in PR 23

| Voce | PR origine | Note |
|---|---|---|
| `Storage construct + Attachments bucket pending` | header MainStack PR #29 | Comment di MainStack riferisce esplicitamente PR 23; resolved questo. |

### 7.3 Non-debt segnalati esplicitamente

- **APPENDICE_C §5.4 letterale `garageos.it`**: il dominio reale è `garageos.aifollyadvisor.com`. PR 23 riconcilia §5.4 nel cambio doc + changelog. Non è un debt residuo perché la spec viene aggiornata.

## 8. Stima dimensioni PR

| File | Tipo | Righe stimate |
|---|---|---|
| `infrastructure/lib/constructs/storage.ts` | NEW | ~80 |
| `infrastructure/lib/constructs/waf.ts` | NEW | ~120 |
| `infrastructure/lib/constructs/api-gateway.ts` | MODIFIED | +5 |
| `infrastructure/lib/constructs/lambda-api.ts` | MODIFIED | +15 |
| `infrastructure/lib/stacks/main-stack.ts` | MODIFIED | +40 |
| `infrastructure/lib/config/production.ts` | MODIFIED | +6 |
| `infrastructure/tests/storage-waf.test.ts` | NEW | ~150 |
| `infrastructure/tests/main-stack.test.ts` | MODIFIED | +30 |
| `infrastructure/README.md` | MODIFIED | +80 |
| `docs/APPENDICE_C_INFRASTRUCTURE.md` | MODIFIED | +20 |
| **Totale stimato** | | **~546 righe net** |

Ben sotto soglia 1200 (alert) e 1500 (hard). Probabili ±100 righe in implementation.

## 9. Rischi e mitigazioni

| Rischio | Probabilità | Impatto | Mitigazione |
|---|---|---|---|
| Stage ARN format errato → WAF association fallisce sintassi CFN | media | alto (synth fail) | Test `storage-waf.test.ts` valida pattern `Fn::Join` corretto; CI synth-mock catch pre-merge. |
| `CfnWebACLAssociation` resource creato troppo presto (prima dello stage) → CFN dependency error | bassa | medio | CDK auto-deriva dependency dal usage di `httpApi.apiId` + `defaultStage.stageName`. Synth-mock conferma. |
| Bucket name collision globale | bassissima | alto (deploy fail) | `garageos-production-attachments` plausibilmente libero (verifica via runbook pre-deploy). Failure path: rename in config. |
| WAF false positive blocca traffico legittimo post-deploy | media | medio | Spec §5.8 rule sono baseline AWS-managed, low FP. Rollback rapido via `cdk deploy` con rule eccettuata in caso. CloudWatch logs per debug. |
| `grantPut` espande a action list più ampia di Get/Put → over-permissive | bassa | basso | Audit pre-merge del CFN template. Action list documentata in test assertion. |
| Auto-deploy fallisce post-merge (path filter triggers, gate richiesto) | bassa | basso (operator richiamato) | PR #47 ha già validato il deploy path. Operator approva il gate `production` quando comodo. |
| Drift APPENDICE_C — chi legge la spec a futuro non sa che §5.4 è aggiornata | bassa | basso | Changelog row v1.3 in §1.3. PR description cita esplicitamente la riconciliazione. |

## 10. Ordine commit consigliato

Atomic commits stile PR #48:
1. `feat(infra): add StorageConstruct with attachments bucket` — solo `storage.ts` + test minimal.
2. `feat(infra): add WafConstruct with REGIONAL Web ACL` — solo `waf.ts` + test minimal.
3. `feat(infra): expose ApiGateway default stage for WAF association` — `api-gateway.ts` only.
4. `feat(infra): grant Lambda execution role S3 read+put on attachments` — `lambda-api.ts` only.
5. `feat(infra): wire Storage + WAF into MainStack with association` — `main-stack.ts` + `production.ts`.
6. `test(infra): assert MainStack outputs and WAF/S3 wiring` — `main-stack.test.ts` extension.
7. `docs(infra): add F-Storage and F-WAF runbook sections` — `README.md`.
8. `docs: reconcile APPENDICE_C §5.4 CORS origins to real domain` — `APPENDICE_C_INFRASTRUCTURE.md` + changelog.

Squash come unico commit alla merge (CI prefence).

## 11. Sequenza post-PR

PR successiva candidata (post merge questo PR):
- **PR 24 SES + Scheduler + Monitoring** — sblocca BR-064/066/129 notifications + verify-email endpoint (debt da PR #48).
- Oppure **PR F-OFF-305 presigned upload endpoint** in `packages/api/` se l'utente preferisce sbloccare attachments end-to-end prima di muoversi sul cluster G. Stima ~400-600 righe (route handler + Zod schema + AWS SDK getSignedUrl + integration test con S3 stub).

Decisione rinviata a fine merge PR 23.
