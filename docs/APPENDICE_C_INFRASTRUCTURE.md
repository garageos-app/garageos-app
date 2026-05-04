# Appendice C — Infrastructure

> **Documento correlato:** questo è un'appendice del documento principale `GarageOS-Specifiche.md`. Definisce l'infrastruttura AWS via CDK, il setup GitHub, le procedure di deployment e gestione ambienti.
>
> **Versione:** v1.1 — allineata a `GarageOS-Specifiche.md` v1.6
> **Ultimo aggiornamento:** 23 aprile 2026

---

## Scopo di questo documento

Questa appendice fornisce tutto il necessario per **portare l'infrastruttura GarageOS dallo stato "vuoto" al primo deploy funzionante** in modo riproducibile. Contenuto:

1. Struttura del progetto CDK
2. Stack AWS completo in TypeScript
3. Setup del dominio e DNS
4. Gestione secrets
5. GitHub organization e repo setup
6. Pipeline CI/CD
7. Procedure operative (deploy, rollback, monitoring)
8. Integrazione Supabase (DB esterno ad AWS)

---

## Indice

1. [Architettura AWS di riferimento](#1-architettura-aws-di-riferimento)
2. [Setup account AWS](#2-setup-account-aws)
3. [Setup GitHub organization](#3-setup-github-organization)
4. [Progetto CDK](#4-progetto-cdk)
5. [Stack CDK completo](#5-stack-cdk-completo)
6. [Integrazione Supabase](#6-integrazione-supabase)
7. [Dominio e DNS](#7-dominio-e-dns)
8. [Gestione secrets](#8-gestione-secrets)
9. [Pipeline CI/CD](#9-pipeline-cicd)
10. [Procedure operative](#10-procedure-operative)
11. [Cost monitoring](#11-cost-monitoring)
12. [Rollback strategy](#12-rollback-strategy)

---

## 1. Architettura AWS di riferimento

### 1.1 Scelte architetturali ricordate

Dalla Sezione 5 del documento master:

- **Region primaria**: `eu-central-1` (Francoforte) — GDPR compliance + bassa latenza IT
- **Region backup**: nessuna in v1 (single-region); in v2 valutare `eu-west-1` per DR
- **Ambienti v1**: **solo production**
- **Account AWS**: **singolo account** per il pilota (in v2 valutare Organizations con account separati per env)

### 1.2 Servizi AWS usati in v1

| Servizio | Scopo | Stack |
|---|---|---|
| **Lambda Functions** | Backend Fastify (via `@fastify/aws-lambda` adapter — see [ADR-0002](./adr/ADR-0002-replace-lwa-with-fastify-aws-lambda-adapter.md)) | Main stack |
| **API Gateway (HTTP API v2)** | Ingress HTTPS verso Lambda | Main stack |
| **Cognito** | Two User Pool (officine, clienti) | Main stack |
| **S3** | Allegati + Tag PDF | Main stack |
| **CloudFront** | CDN asset web app | Main stack |
| **Route 53** | DNS + registrar dominio | Main stack |
| **Certificate Manager** | SSL certs | Main stack |
| **WAF** | Protezione API | Main stack |
| **EventBridge Scheduler** | Promemoria scadenze + warming Lambda | Main stack |
| **SES** | Email transazionali | Main stack |
| **Secrets Manager** | Secrets applicativi | Main stack |
| **CloudWatch** | Logs + metrics + alarms | Main stack |
| **X-Ray** | Distributed tracing API Gateway + Lambda | Main stack |
| **IAM** | Ruoli e policy | Main stack |

**Servizi esterni ad AWS** (non gestiti via CDK):
- **Supabase** — PostgreSQL managed (gestito via dashboard Supabase)
- **Expo Push Service** — gestito via Expo dashboard
- **Sentry** — gestito via Sentry dashboard

### 1.3 Changelog

| Versione | Data | Modifiche principali |
|---|---|---|
| **v1.2** | 2026-04-29 | Sostituito AWS Lambda Web Adapter con l'in-process adapter `@fastify/aws-lambda`. Rationale e dettagli in [ADR-0002](./adr/ADR-0002-replace-lwa-with-fastify-aws-lambda-adapter.md). §5.9 aggiornata per riflettere il nuovo construct (rimosso layer LWA, rimosse env `AWS_LWA_PORT` / `AWS_LWA_READINESS_CHECK_PATH` / `AWS_LWA_ASYNC_INIT` / `AWS_LAMBDA_EXEC_WRAPPER`, aggiunto banner `createRequire` + handler `awsLambdaFastify`). La decisione fondamentale Lambda + API Gateway HTTP API v2 (v1.1) resta invariata. |
| v1.1 | 2026-04-23 | Runtime backend aggiornato da App Runner a **Lambda + API Gateway HTTP API v2 + Lambda Web Adapter**. Motivazione: App Runner chiuso alle nuove iscrizioni dal 2026-04-30 (AWS announcement). Lambda offre costi 10-30× inferiori al volume pilota (<1M req/mese resta in free tier), scale-to-zero nativo, future-proof AWS. Refactoring packaging backend: bundling esbuild via `aws-cdk-lib/aws-lambda-nodejs` invece di container Docker ECR. Rimosse §10.3 (custom domain manuale): ora gestito da CDK via `aws-cdk-lib/aws-apigatewayv2` `DomainName` + `ApiMapping`. Nuova §11.4 con tabella stime costi backend runtime. **Nota retrospettiva (v1.2)**: la scelta di LWA è stata sostituita 6 giorni dopo — vedi ADR-0002. |
| v1.0 | 2026-04-22 | Versione iniziale, allineata a `GarageOS-Specifiche.md` v1.5. |

---

## 2. Setup account AWS

### 2.1 Creazione account

1. Andare su [aws.amazon.com](https://aws.amazon.com) → Create an AWS Account
2. Email consigliata: **non personale**, usare `aws-admin@garageos.it` (o simile) dopo aver acquisito il dominio
3. Inserire carta di credito (billing)
4. Scegliere Plan "Basic" (free tier incluso)
5. Verificare email e telefono

### 2.2 Hardening account root

**Immediatamente dopo la creazione:**

1. **Abilitare MFA sull'utente root** (hardware key o authenticator app)
2. **Non usare più l'utente root** per operazioni quotidiane
3. **Creare IAM user admin** per operazioni normali:
   ```
   IAM → Users → Add users
   Name: garageos-admin
   Access type: AWS Management Console + Programmatic access
   Policy: AdministratorAccess (temporaneo; poi granulare)
   ```
4. Abilitare MFA anche su `garageos-admin`
5. Salvare access key / secret key in password manager
6. Configurare AWS CLI locale:
   ```bash
   aws configure --profile garageos
   # AWS Access Key ID: ...
   # AWS Secret Access Key: ...
   # Default region: eu-central-1
   # Default output format: json
   ```

### 2.3 Budget alert

**Prima di qualsiasi altra cosa**, configurare budget alert per evitare sorprese:

```
Billing → Budgets → Create budget

Tipo: Cost budget
Nome: garageos-monthly
Periodo: Monthly
Importo: €100 (pilota), aumentabile in seguito

Alert thresholds:
- 50% → warning email
- 80% → warning email
- 100% → critical email
```

### 2.4 Abilitare servizi in region EU

Alcuni servizi AWS richiedono opt-in per region:

- **SES**: partenza in "sandbox mode" (solo invio a email verificate). Bisogna chiedere il **production access** per uscire dalla sandbox
- **WAF**: no opt-in, ma assicurarsi di usare la region Frankfurt
- **Cognito**: nessun opt-in, ma configurare email settings (SES integration) dopo sandbox exit

### 2.5 Richiesta production access SES

Step importante, richiede 1-3 giorni lavorativi di review:

1. SES Console → Account dashboard
2. Sandbox limit → "Request production access"
3. Form: descrivere caso d'uso (email transazionali per SaaS multi-tenant), stimare volumi (<10k/mese in v1)
4. Attendere conferma AWS

**In attesa dell'approvazione:** verificare manualmente le email dei primi tenant pilota per test.

---

## 3. Setup GitHub organization

### 3.1 Creazione organization

1. Andare su [github.com/organizations/new](https://github.com/organizations/new)
2. Scegliere "Free" plan (fino a 2000 minuti CI/mese, sufficiente per v1)
3. Nome suggerito: `garageos` o `garageos-app`
4. Email contatto: stessa usata per AWS admin

**Upgrade path:** quando il team cresce (più di 3 sviluppatori), valutare Team plan ($4/user/mese) per più Actions minutes e security features.

### 3.2 Repository suggeriti

Struttura monorepo con un repo principale:

```
garageos/
└── garageos-app/                    # Monorepo principale
    ├── packages/
    │   ├── api/                     # Backend Fastify
    │   ├── web-app/                 # Web officine (React + Vite)
    │   ├── mobile-app/              # Mobile clienti (React Native Expo)
    │   ├── database/                # Prisma schema + migrations + Zod
    │   ├── shared/                  # Types/utility condivisi
    │   └── e2e/                     # Test E2E
    ├── infrastructure/              # CDK
    │   ├── lib/
    │   └── bin/
    ├── .github/
    │   └── workflows/
    ├── package.json
    ├── pnpm-workspace.yaml
    └── README.md
```

**Alternativa multi-repo (non raccomandato in v1):** separare in repo distinti per `api`, `web`, `mobile`. Introduce più complessità di gestione senza benefici in team piccolo.

### 3.3 Repository settings raccomandati

Su `garageos-app`:

**Branch protection per `main`:**
- Require pull request before merging
- Require approvals: 1 (per solo developer) o 2 (team)
- Require status checks: `lint`, `typecheck`, `test:unit`, `test:integration`
- Require branches to be up to date
- Do not allow bypassing
- Restrict who can push to matching branches (no direct push)

**Secrets & variables → Actions:**
- `AWS_DEPLOY_ROLE_ARN` — ARN del ruolo OIDC (vedi 3.4)
- `AWS_REGION` — `eu-central-1`
- `EXPO_TOKEN` — per EAS Build
- `SENTRY_AUTH_TOKEN` — per sourcemap upload

**Environments:**
- `production` — con "Required reviewers" per il deploy (manual approval)

### 3.4 OIDC trust tra GitHub e AWS

Per permettere a GitHub Actions di deployare su AWS **senza access key hardcoded**, si usa OIDC federation.

**Setup (eseguito una sola volta via CDK o manualmente):**

1. In AWS IAM, creare **OIDC identity provider**:
   - Provider URL: `https://token.actions.githubusercontent.com`
   - Audience: `sts.amazonaws.com`

2. Creare **IAM Role** con trust policy:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Principal": {
         "Federated": "arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"
       },
       "Action": "sts:AssumeRoleWithWebIdentity",
       "Condition": {
         "StringEquals": {
           "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
           "token.actions.githubusercontent.com:sub": "repo:garageos/garageos-app:ref:refs/heads/main"
         }
       }
     }]
   }
   ```

3. Attaccare policy di deploy (iniziale: `PowerUserAccess`, poi restringere in v1.1)

4. In GitHub Actions, usare:
   ```yaml
   permissions:
     id-token: write
     contents: read

   - uses: aws-actions/configure-aws-credentials@v4
     with:
       role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}
       aws-region: eu-central-1
   ```

### 3.5 Secrets management — cosa NON committare

Lista di file/valori che **NON** devono mai finire in Git:

- `.env`, `.env.local`, `.env.production`
- Qualsiasi file contenente password DB, API keys, certificates
- File `cdk.out/` (generato, contiene config derived)
- `.aws/credentials`

**`.gitignore` iniziale raccomandato:**

```gitignore
# Dependencies
node_modules/
.pnpm-store/

# Build outputs
dist/
build/
.turbo/
cdk.out/
*.log

# Env files
.env
.env.*
!.env.example

# OS
.DS_Store
Thumbs.db

# IDE
.vscode/
.idea/
*.swp

# Testing
coverage/
playwright-report/
test-results/

# Expo
.expo/
```

---

## 4. Progetto CDK

### 4.1 Scelta: AWS CDK in TypeScript

**Perché CDK e non Terraform:**
- Coerenza con stack (TS ovunque)
- Possibilità di condividere types con il backend
- Meno boilerplate per pattern comuni (construct library)
- Deploy con comandi semplici (`cdk deploy`)

### 4.2 Struttura cartelle `infrastructure/`

```
infrastructure/
├── bin/
│   └── garageos.ts              # Entry point, crea l'app CDK
├── lib/
│   ├── stacks/
│   │   ├── main-stack.ts        # Stack principale (tutti i servizi)
│   │   └── oidc-stack.ts        # GitHub OIDC trust (una tantum)
│   ├── constructs/
│   │   ├── lambda-api.ts        # Construct Lambda backend (Fastify via @fastify/aws-lambda)
│   │   ├── api-gateway.ts       # Construct API Gateway HTTP API v2
│   │   ├── cognito-pools.ts     # Construct per i due User Pool
│   │   ├── storage.ts           # S3 buckets
│   │   ├── waf.ts               # WAF + rules
│   │   ├── dns.ts               # Route 53 + ACM cert
│   │   └── monitoring.ts        # CloudWatch alarms
│   └── config/
│       └── production.ts        # Config env production
├── cdk.json                     # CDK config
├── package.json
├── tsconfig.json
└── README.md
```

### 4.3 Setup iniziale

```bash
# Dalla root del monorepo
mkdir infrastructure && cd infrastructure

# Install CDK
pnpm add -D aws-cdk aws-cdk-lib constructs typescript @types/node

# Init config
pnpm cdk init app --language typescript --generate-only

# CDK bootstrap (una tantum per account/region)
pnpm cdk bootstrap aws://ACCOUNT_ID/eu-central-1
```

### 4.4 File `cdk.json`

```json
{
  "app": "npx tsx bin/garageos.ts",
  "watch": {
    "include": ["**"],
    "exclude": ["README.md", "cdk*.json", "**/*.d.ts", "**/*.js", "tsconfig.json", "node_modules"]
  },
  "context": {
    "@aws-cdk/aws-lambda:recognizeLayerVersion": true,
    "@aws-cdk/core:checkSecretUsage": true,
    "@aws-cdk/aws-iam:minimizePolicies": true,
    "@aws-cdk/core:stackRelativeExports": true,
    "@aws-cdk/aws-ecr-assets:dockerIgnoreSupport": true
  }
}
```

### 4.5 Entry point `bin/garageos.ts`

```typescript
#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { MainStack } from '../lib/stacks/main-stack';
import { OidcStack } from '../lib/stacks/oidc-stack';
import { productionConfig } from '../lib/config/production';

const app = new cdk.App();

// OIDC trust per GitHub Actions — deploy una tantum
new OidcStack(app, 'GarageosOidcStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'eu-central-1',
  },
  githubOrg: 'garageos',
  githubRepo: 'garageos-app',
});

// Main stack
new MainStack(app, 'GarageosMainStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'eu-central-1',
  },
  config: productionConfig,
  description: 'GarageOS production stack (v1)',
  tags: {
    Environment: 'production',
    Project: 'garageos',
    ManagedBy: 'cdk',
  },
});
```

---

## 5. Stack CDK completo

### 5.1 Config `lib/config/production.ts`

```typescript
export interface EnvironmentConfig {
  environment: 'production';
  domainName: string;
  apiSubdomain: string;
  appSubdomain: string;
  emailFromDomain: string;
  emailFromAddress: string;
  lambda: {
    memoryMb: number;
    architecture: 'x86_64' | 'arm64';
    timeoutSec: number;
    reservedConcurrency: number;
    runtime: 'nodejs22.x';
  };
  apiGateway: {
    throttleBurst: number;
    throttleRate: number;
  };
  logRetentionDays: number;
  wafEnabled: boolean;
}

export const productionConfig: EnvironmentConfig = {
  environment: 'production',
  domainName: 'garageos.it',
  apiSubdomain: 'api',
  appSubdomain: 'app',
  emailFromDomain: 'garageos.it',
  emailFromAddress: 'noreply@garageos.it',
  lambda: {
    memoryMb: 1024,
    architecture: 'arm64',
    timeoutSec: 30,
    reservedConcurrency: 100,
    runtime: 'nodejs22.x',
  },
  apiGateway: {
    throttleBurst: 200,
    throttleRate: 100,
  },
  logRetentionDays: 30,
  wafEnabled: true,
};
```

### 5.2 Main Stack `lib/stacks/main-stack.ts`

```typescript
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { EnvironmentConfig } from '../config/production';
import { DnsConstruct } from '../constructs/dns';
import { StorageConstruct } from '../constructs/storage';
import { CognitoConstruct } from '../constructs/cognito-pools';
import { SecretsConstruct } from '../constructs/secrets';
import { WafConstruct } from '../constructs/waf';
import { LambdaApiConstruct } from '../constructs/lambda-api';
import { ApiGatewayConstruct } from '../constructs/api-gateway';
import { SchedulerConstruct } from '../constructs/scheduler';
import { SesConstruct } from '../constructs/ses';
import { MonitoringConstruct } from '../constructs/monitoring';

interface MainStackProps extends cdk.StackProps {
  config: EnvironmentConfig;
}

export class MainStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MainStackProps) {
    super(scope, id, props);

    const { config } = props;

    // 1. DNS + ACM certificate
    const dns = new DnsConstruct(this, 'Dns', {
      domainName: config.domainName,
    });

    // 2. Storage (S3 buckets)
    const storage = new StorageConstruct(this, 'Storage', {
      environment: config.environment,
    });

    // 3. Cognito user pools
    const cognito = new CognitoConstruct(this, 'Cognito', {
      environment: config.environment,
      domainName: config.domainName,
    });

    // 4. Secrets Manager
    const secrets = new SecretsConstruct(this, 'Secrets', {
      environment: config.environment,
    });

    // 5. SES (domain verification + configuration set)
    const ses = new SesConstruct(this, 'Ses', {
      domainName: config.emailFromDomain,
      hostedZone: dns.hostedZone,
    });

    // 6. WAF
    const waf = config.wafEnabled
      ? new WafConstruct(this, 'Waf', { scope: 'REGIONAL' })
      : null;

    // 7. Lambda backend (Fastify via @fastify/aws-lambda adapter)
    const lambdaApi = new LambdaApiConstruct(this, 'LambdaApi', {
      config,
      attachmentsBucket: storage.attachmentsBucket,
      cognitoPoolOfficine: cognito.officineUserPool,
      cognitoPoolClienti: cognito.clientiUserPool,
      secrets: secrets.appSecrets,
    });

    // 8. API Gateway HTTP API v2 (ingress HTTPS → Lambda)
    const apiGateway = new ApiGatewayConstruct(this, 'ApiGateway', {
      config,
      lambdaFunction: lambdaApi.function,
      hostedZone: dns.hostedZone,
      certificate: dns.apiCertificate,
    });

    // 9. EventBridge Scheduler (deadline reminders + Lambda warming)
    const scheduler = new SchedulerConstruct(this, 'Scheduler', {
      lambdaFunction: lambdaApi.function,
      hmacSecret: secrets.eventbridgeHmacSecret,
    });

    // 10. Monitoring (CloudWatch alarms)
    new MonitoringConstruct(this, 'Monitoring', {
      lambdaFunction: lambdaApi.function,
      httpApi: apiGateway.httpApi,
      attachmentsBucket: storage.attachmentsBucket,
      logRetentionDays: config.logRetentionDays,
    });

    // Outputs
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: `https://${config.apiSubdomain}.${config.domainName}`,
    });
    new cdk.CfnOutput(this, 'AppUrl', {
      value: `https://${config.appSubdomain}.${config.domainName}`,
    });
    new cdk.CfnOutput(this, 'LambdaFunctionArn', {
      value: lambdaApi.function.functionArn,
    });
    new cdk.CfnOutput(this, 'HttpApiEndpoint', {
      value: apiGateway.httpApi.apiEndpoint,
    });
    new cdk.CfnOutput(this, 'CognitoOfficineUserPoolId', {
      value: cognito.officineUserPool.userPoolId,
    });
    new cdk.CfnOutput(this, 'CognitoClientiUserPoolId', {
      value: cognito.clientiUserPool.userPoolId,
    });
    new cdk.CfnOutput(this, 'AttachmentsBucketName', {
      value: storage.attachmentsBucket.bucketName,
    });
  }
}
```

### 5.3 Construct: DNS e Certificato

```typescript
// lib/constructs/dns.ts
import { Construct } from 'constructs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';

interface DnsProps {
  domainName: string;
}

export class DnsConstruct extends Construct {
  public readonly hostedZone: route53.IHostedZone;
  public readonly apiCertificate: acm.ICertificate;
  public readonly appCertificate: acm.ICertificate;

  constructor(scope: Construct, id: string, props: DnsProps) {
    super(scope, id);

    // Hosted zone (creata manualmente o con Registrar)
    this.hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
      domainName: props.domainName,
    });

    // Certificato wildcard per *.domain
    this.apiCertificate = new acm.Certificate(this, 'ApiCert', {
      domainName: `api.${props.domainName}`,
      validation: acm.CertificateValidation.fromDns(this.hostedZone),
    });

    this.appCertificate = new acm.Certificate(this, 'AppCert', {
      domainName: `app.${props.domainName}`,
      validation: acm.CertificateValidation.fromDns(this.hostedZone),
    });
  }
}
```

### 5.4 Construct: Storage

```typescript
// lib/constructs/storage.ts
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cdk from 'aws-cdk-lib';

interface StorageProps {
  environment: string;
}

export class StorageConstruct extends Construct {
  public readonly attachmentsBucket: s3.IBucket;

  constructor(scope: Construct, id: string, props: StorageProps) {
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
          allowedOrigins: ['https://app.garageos.it', 'https://garageos.it'],
          allowedHeaders: ['*'],
          maxAge: 3000,
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
  }
}
```

### 5.5 Construct: Cognito User Pools

```typescript
// lib/constructs/cognito-pools.ts
import { Construct } from 'constructs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as cdk from 'aws-cdk-lib';

interface CognitoProps {
  environment: string;
  domainName: string;
}

export class CognitoConstruct extends Construct {
  public readonly officineUserPool: cognito.UserPool;
  public readonly clientiUserPool: cognito.UserPool;
  public readonly officineClient: cognito.UserPoolClient;
  public readonly clientiClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: CognitoProps) {
    super(scope, id);

    // --- Pool OFFICINE ---
    this.officineUserPool = new cognito.UserPool(this, 'OfficineUserPool', {
      userPoolName: `garageos-${props.environment}-officine`,
      selfSignUpEnabled: true,
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
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.officineClient = this.officineUserPool.addClient('OfficineClient', {
      userPoolClientName: 'garageos-officine-client',
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
      preventUserExistenceErrors: true,
    });

    // --- Pool CLIENTI ---
    this.clientiUserPool = new cognito.UserPool(this, 'ClientiUserPool', {
      userPoolName: `garageos-${props.environment}-clienti`,
      selfSignUpEnabled: false, // server-driven signup via /v1/auth/signup
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
        requireSymbols: false,
        requireUppercase: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      mfa: cognito.Mfa.OFF,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.clientiClient = this.clientiUserPool.addClient('ClientiClient', {
      userPoolClientName: 'garageos-clienti-client',
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(60),
      preventUserExistenceErrors: true,
    });
  }
}
```

**`selfSignUpEnabled: false`** (decisione intenzionale, 2026-05-04). Il flusso di registrazione customer è server-driven via `POST /v1/auth/signup` per garantire che `custom:customer_id` sia popolato in modo trusted al momento della creazione del Cognito user (la middleware `clientiContext` valida il claim come PK tabella `customers`). Self-signup nativo Cognito non avrebbe modo di settare `customer_id` senza un PreSignUp lambda trigger separato — costo ingegneristico più alto rispetto al beneficio. Vedi `docs/superpowers/specs/2026-05-04-api-customer-signup-design.md` §3.1.

### 5.6 Construct: Secrets Manager

```typescript
// lib/constructs/secrets.ts
import { Construct } from 'constructs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cdk from 'aws-cdk-lib';

interface SecretsProps {
  environment: string;
}

export class SecretsConstruct extends Construct {
  public readonly appSecrets: secretsmanager.Secret;
  public readonly eventbridgeHmacSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: SecretsProps) {
    super(scope, id);

    // Secret con tutte le credenziali applicative
    // Valori sono placeholder; vengono aggiornati manualmente dopo il primo deploy
    this.appSecrets = new secretsmanager.Secret(this, 'AppSecrets', {
      secretName: `garageos/${props.environment}/app`,
      description: 'Application secrets (DB, external services)',
      secretObjectValue: {
        DATABASE_URL: cdk.SecretValue.unsafePlainText('REPLACE_AFTER_DEPLOY'),
        DIRECT_URL: cdk.SecretValue.unsafePlainText('REPLACE_AFTER_DEPLOY'),
        SENTRY_DSN: cdk.SecretValue.unsafePlainText('REPLACE_AFTER_DEPLOY'),
        EXPO_ACCESS_TOKEN: cdk.SecretValue.unsafePlainText('REPLACE_AFTER_DEPLOY'),
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // HMAC secret per auth endpoints interni (EventBridge Scheduler → Lambda)
    this.eventbridgeHmacSecret = new secretsmanager.Secret(this, 'EventBridgeHmac', {
      secretName: `garageos/${props.environment}/eventbridge-hmac`,
      description: 'HMAC secret for EventBridge Scheduler callbacks',
      generateSecretString: {
        passwordLength: 64,
        excludeCharacters: '"\'\\',
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
  }
}
```

### 5.7 Construct: SES

```typescript
// lib/constructs/ses.ts
import { Construct } from 'constructs';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as route53 from 'aws-cdk-lib/aws-route53';

interface SesProps {
  domainName: string;
  hostedZone: route53.IHostedZone;
}

export class SesConstruct extends Construct {
  public readonly configurationSet: ses.ConfigurationSet;

  constructor(scope: Construct, id: string, props: SesProps) {
    super(scope, id);

    // Identity verification via DKIM (automatic DNS record creation)
    new ses.EmailIdentity(this, 'Identity', {
      identity: ses.Identity.publicHostedZone(props.hostedZone),
      mailFromDomain: `mail.${props.domainName}`,
    });

    this.configurationSet = new ses.ConfigurationSet(this, 'ConfigSet', {
      configurationSetName: 'garageos-production',
      sendingEnabled: true,
      reputationMetrics: true,
    });
  }
}
```

### 5.8 Construct: WAF

```typescript
// lib/constructs/waf.ts
import { Construct } from 'constructs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';

interface WafProps {
  scope: 'REGIONAL' | 'CLOUDFRONT';
}

export class WafConstruct extends Construct {
  public readonly webAcl: wafv2.CfnWebACL;

  constructor(scope: Construct, id: string, props: WafProps) {
    super(scope, id);

    this.webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      scope: props.scope,
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
              limit: 2000,
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

### 5.9 Construct: Lambda API (Fastify via `@fastify/aws-lambda` adapter)

> **Nota storica (ADR-0002)**: dal 2026-04-29 questo construct usa l'adapter in-process [`@fastify/aws-lambda`](https://github.com/fastify/aws-lambda-fastify) al posto dell'AWS Lambda Web Adapter (LWA) originariamente previsto in v1.1 di questa appendice. Razionale completo in [ADR-0002](./adr/ADR-0002-replace-lwa-with-fastify-aws-lambda-adapter.md). Sezione aggiornata di conseguenza.

Il backend Fastify gira su AWS Lambda tramite [`@fastify/aws-lambda`](https://github.com/fastify/aws-lambda-fastify): l'adapter wrappa l'istanza Fastify e traduce in-process eventi APIGW HTTP API v2 ↔ richieste/risposte Fastify, senza HTTP localhost loop, senza extension layer, senza port mapping. La Fastify app resta standard — l'unica modifica al codice è il wrap `handler = awsLambdaFastify(app)` esportato da `packages/api/src/index.ts` (vedi commenti in quel file per l'ordine `wrap → ready` imposto da Fastify).

**Scelte chiave:**
- **arm64 (Graviton)**: ~20% risparmio costo, piena compatibilità Node.js 22
- **1024 MB memory**: adeguato per Fastify + Prisma con pool ~10-20 connessioni
- **30s timeout**: margine per query DB complesse (default 3s insufficiente)
- **Reserved concurrency = 100**: cap di protezione contro runaway invocations
- **No VPC**: accesso Supabase via internet pubblico (evita cold start penalty ENI ~1-2s)
- **Bundling esbuild**: `NodejsFunction` L2 fa tree-shaking e minify automaticamente
- **Log retention 7 giorni**: ottimizzazione costi CloudWatch (principale voce al pilota)

> ⚠️ **Versioni al momento della stesura (2026-04-29 v1.2) — verificare prima del deploy:**
> - `aws-cdk-lib` 2.250.0
> - `@fastify/aws-lambda` runtime dependency in `packages/api` (no Lambda layer required)
> - Lambda runtime `Runtime.NODEJS_22_X` (LTS fino aprile 2027)
>
> Se le versioni sono cambiate, aggiornare prima del primo `cdk deploy`.

```typescript
// lib/constructs/lambda-api.ts
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib';
import { EnvironmentConfig } from '../config/production';
import * as path from 'node:path';

interface LambdaApiProps {
  config: EnvironmentConfig;
  attachmentsBucket: s3.IBucket;
  cognitoPoolOfficine: cognito.IUserPool;
  cognitoPoolClienti: cognito.IUserPool;
  secrets: secretsmanager.ISecret;
}

export class LambdaApiConstruct extends Construct {
  public readonly function: lambda.IFunction;
  public readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: LambdaApiProps) {
    super(scope, id);

    const { config } = props;

    // IAM role per la Lambda (esegue il codice Fastify)
    const executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaBasicExecutionRole',
        ),
      ],
    });

    // Permessi: S3 allegati, Cognito admin, Secrets, EventBridge Scheduler, SES
    props.attachmentsBucket.grantReadWrite(executionRole);
    props.secrets.grantRead(executionRole);

    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'cognito-idp:AdminGetUser',
        'cognito-idp:AdminCreateUser',
        'cognito-idp:AdminUpdateUserAttributes',
        'cognito-idp:ListUsers',
      ],
      resources: [
        props.cognitoPoolOfficine.userPoolArn,
        props.cognitoPoolClienti.userPoolArn,
      ],
    }));

    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'scheduler:CreateSchedule',
        'scheduler:DeleteSchedule',
        'scheduler:UpdateSchedule',
        'scheduler:GetSchedule',
      ],
      resources: ['*'],
    }));

    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: ['*'],
    }));

    // Log group con retention esplicita (ottimizzazione costi CloudWatch)
    this.logGroup = new logs.LogGroup(this, 'ApiLogGroup', {
      logGroupName: '/aws/lambda/garageos-api',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Lambda function — bundling esbuild automatico via NodejsFunction L2.
    // No Lambda layer: l'adapter `@fastify/aws-lambda` viene bundlato
    // come dipendenza runtime di packages/api ed esegue in-process.
    const fn = new lambdaNodejs.NodejsFunction(this, 'ApiFunction', {
      functionName: 'garageos-api',
      entry: path.join(__dirname, '../../../packages/api/src/index.ts'),
      handler: 'handler', // packages/api/src/index.ts esporta `handler = awsLambdaFastify(app)`
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: config.lambda.memoryMb,
      timeout: cdk.Duration.seconds(config.lambda.timeoutSec),
      reservedConcurrentExecutions: config.lambda.reservedConcurrency,
      role: executionRole,
      logGroup: this.logGroup,
      tracing: lambda.Tracing.ACTIVE, // X-Ray
      environment: {
        NODE_ENV: 'production',
        ATTACHMENTS_BUCKET: props.attachmentsBucket.bucketName,
        COGNITO_OFFICINE_POOL_ID: props.cognitoPoolOfficine.userPoolId,
        COGNITO_CLIENTI_POOL_ID: props.cognitoPoolClienti.userPoolId,
        APP_SECRETS_ARN: props.secrets.secretArn,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
        format: lambdaNodejs.OutputFormat.ESM,
        // CommonJS-in-ESM compatibility shim. esbuild ESM rewrite static
        // imports as ESM ma lascia intatti i `require()` dinamici delle
        // transitive deps (Fastify plugins, Prisma client). Senza questo
        // banner il Lambda crasha al boot con "Dynamic require of X is
        // not supported".
        banner:
          "import{createRequire as __createRequire}from'module';const require=__createRequire(import.meta.url);",
        // Escludere SDK AWS v3 (già presente nel runtime Lambda) e shipare
        // @prisma/client come nodeModules per includere il binary nativo
        externalModules: ['@aws-sdk/*'],
        nodeModules: ['@prisma/client'],
      },
    });

    this.function = fn;
  }
}
```

### 5.9.1 Construct: API Gateway HTTP API v2

Ingress HTTPS pubblico verso la Lambda. Usiamo **HTTP API v2** invece di REST API v1: ~70% più economica ($1.00 vs $3.50 per milione di richieste) e sufficiente per il nostro caso d'uso (niente usage plans, niente API keys complesse).

```typescript
// lib/constructs/api-gateway.ts
import { Construct } from 'constructs';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwIntegrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib';
import { EnvironmentConfig } from '../config/production';

interface ApiGatewayProps {
  config: EnvironmentConfig;
  lambdaFunction: lambda.IFunction;
  hostedZone: route53.IHostedZone;
  certificate: acm.ICertificate;
}

export class ApiGatewayConstruct extends Construct {
  public readonly httpApi: apigw.HttpApi;
  public readonly domainName: apigw.DomainName;
  public readonly accessLogGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: ApiGatewayProps) {
    super(scope, id);

    const { config } = props;
    const fqdn = `${config.apiSubdomain}.${config.domainName}`;

    // Access logs: JSON strutturato a CloudWatch
    this.accessLogGroup = new logs.LogGroup(this, 'AccessLogs', {
      logGroupName: '/aws/apigateway/garageos-api-access',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Custom domain (gestito da CDK nativamente — niente step manuale post-deploy)
    this.domainName = new apigw.DomainName(this, 'DomainName', {
      domainName: fqdn,
      certificate: props.certificate,
      endpointType: apigw.EndpointType.REGIONAL,
      securityPolicy: apigw.SecurityPolicy.TLS_1_2,
    });

    // HTTP API v2
    this.httpApi = new apigw.HttpApi(this, 'HttpApi', {
      apiName: 'garageos-api',
      description: 'GarageOS backend (Fastify on Lambda)',
      corsPreflight: {
        allowOrigins: [
          'https://app.garageos.it',
          'https://garageos.it',
          // Expo dev client + EAS production builds (deep links)
          'exp://',
          'garageos://',
        ],
        allowMethods: [
          apigw.CorsHttpMethod.GET,
          apigw.CorsHttpMethod.POST,
          apigw.CorsHttpMethod.PUT,
          apigw.CorsHttpMethod.PATCH,
          apigw.CorsHttpMethod.DELETE,
          apigw.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['Authorization', 'Content-Type', 'X-Tenant-Id', 'X-Idempotency-Key'],
        exposeHeaders: ['X-Request-Id'],
        maxAge: cdk.Duration.hours(1),
        allowCredentials: false,
      },
      defaultDomainMapping: {
        domainName: this.domainName,
      },
      disableExecuteApiEndpoint: false, // utile per smoke test pre-DNS cutover
    });

    // Throttle di default (burst + rate per stage)
    const defaultStage = this.httpApi.defaultStage?.node.defaultChild as apigw.CfnStage;
    if (defaultStage) {
      defaultStage.defaultRouteSettings = {
        throttlingBurstLimit: config.apiGateway.throttleBurst,
        throttlingRateLimit: config.apiGateway.throttleRate,
        detailedMetricsEnabled: true,
      };
      // Access logs in formato JSON
      defaultStage.accessLogSettings = {
        destinationArn: this.accessLogGroup.logGroupArn,
        format: JSON.stringify({
          requestId: '$context.requestId',
          ip: '$context.identity.sourceIp',
          requestTime: '$context.requestTime',
          httpMethod: '$context.httpMethod',
          routeKey: '$context.routeKey',
          status: '$context.status',
          protocol: '$context.protocol',
          responseLength: '$context.responseLength',
          integrationLatency: '$context.integrationLatency',
          userAgent: '$context.identity.userAgent',
        }),
      };
    }

    // Integrazione Lambda proxy (catch-all)
    const integration = new apigwIntegrations.HttpLambdaIntegration(
      'LambdaIntegration',
      props.lambdaFunction,
      {
        payloadFormatVersion: apigw.PayloadFormatVersion.VERSION_2_0,
      },
    );

    this.httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [apigw.HttpMethod.ANY],
      integration,
    });

    // Route 53 A record alias verso API Gateway regional endpoint
    new route53.ARecord(this, 'ApiAliasRecord', {
      zone: props.hostedZone,
      recordName: config.apiSubdomain,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.ApiGatewayv2DomainProperties(
          this.domainName.regionalDomainName,
          this.domainName.regionalHostedZoneId,
        ),
      ),
    });
  }
}
```

### 5.10 Construct: Scheduler

```typescript
// lib/constructs/scheduler.ts
import { Construct } from 'constructs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

interface SchedulerProps {
  lambdaFunction: lambda.IFunction;
  hmacSecret: secretsmanager.ISecret;
}

export class SchedulerConstruct extends Construct {
  public readonly schedulerRole: iam.Role;
  public readonly scheduleGroup: scheduler.CfnScheduleGroup;
  public readonly warmingSchedule: scheduler.CfnSchedule;

  constructor(scope: Construct, id: string, props: SchedulerProps) {
    super(scope, id);

    // Schedule group dedicato per le scadenze (deadline reminders)
    this.scheduleGroup = new scheduler.CfnScheduleGroup(this, 'DeadlineGroup', {
      name: 'garageos-deadlines',
    });

    // Role usato da EventBridge per invocare endpoint HTTP (scadenze) e Lambda (warming)
    this.schedulerRole = new iam.Role(this, 'SchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      inlinePolicies: {
        InvokeHttp: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['scheduler:InvokeHTTPEndpoint'],
              resources: ['*'],
            }),
            new iam.PolicyStatement({
              actions: ['secretsmanager:GetSecretValue'],
              resources: [props.hmacSecret.secretArn],
            }),
          ],
        }),
        InvokeLambda: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['lambda:InvokeFunction'],
              resources: [props.lambdaFunction.functionArn],
            }),
          ],
        }),
      },
    });

    // Warming schedule: invoca la Lambda ogni 5 minuti dal lunedì al sabato
    // 08:00-20:00 Europe/Rome. L'handler Fastify deve rispondere rapidamente
    // a `{ source: 'warming' }` senza toccare DB. Costo trascurabile
    // (~3500 invocazioni/mese, dentro free tier Lambda).
    this.warmingSchedule = new scheduler.CfnSchedule(this, 'WarmingSchedule', {
      name: 'garageos-api-warming',
      groupName: 'default',
      description: 'Keep Lambda warm during business hours (reduces p99 cold-start tail)',
      state: 'ENABLED',
      scheduleExpression: 'cron(*/5 8-20 ? * MON-SAT *)',
      scheduleExpressionTimezone: 'Europe/Rome',
      flexibleTimeWindow: { mode: 'OFF' },
      target: {
        arn: props.lambdaFunction.functionArn,
        roleArn: this.schedulerRole.roleArn,
        input: JSON.stringify({ source: 'warming' }),
        retryPolicy: {
          maximumRetryAttempts: 0,
        },
      },
    });

    // Individual deadline schedules sono creati runtime dall'applicazione
    // tramite SchedulerClient SDK. Qui si prepara solo l'infrastruttura base.
  }
}
```

### 5.11 Construct: Monitoring

**Metriche osservate:**

| Fonte | Metriche |
|---|---|
| `AWS/Lambda` (dimensione `FunctionName=garageos-api`) | `Duration` (p50/p95/p99), `Errors`, `Throttles`, `ConcurrentExecutions`, `Invocations` |
| `AWS/ApiGateway` (dimensione `ApiId`) | `4xx`, `5xx`, `Latency`, `IntegrationLatency`, `Count` |

**Cold start**: non esiste una metrica CloudWatch nativa. Si deriva con una query **CloudWatch Logs Insights** su `REPORT` records della Lambda:

```
filter @type = "REPORT"
| stats count(*) as invocations, count(@initDuration) as coldStarts,
        (count(@initDuration) * 100 / count(*)) as coldStartPct by bin(5m)
```

In alternativa, la service map **X-Ray** mostra p99 di `Initialization` segment. X-Ray è abilitato sia sull'HTTP API che sulla Lambda (`Tracing.ACTIVE`).

```typescript
// lib/constructs/monitoring.ts
import { Construct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as cdk from 'aws-cdk-lib';

interface MonitoringProps {
  lambdaFunction: lambda.IFunction;
  httpApi: apigw.HttpApi;
  attachmentsBucket: s3.IBucket;
  logRetentionDays: number;
}

export class MonitoringConstruct extends Construct {
  public readonly alertTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: MonitoringProps) {
    super(scope, id);

    // SNS topic per alert (email subscription aggiunta post-deploy via console o CLI)
    this.alertTopic = new sns.Topic(this, 'AlertTopic', {
      displayName: 'GarageOS Production Alerts',
    });

    const lambdaDims = { FunctionName: props.lambdaFunction.functionName };
    const apiDims = { ApiId: props.httpApi.apiId };

    // Alarm: Lambda error rate > 5% su finestra 5 min
    new cloudwatch.Alarm(this, 'LambdaHighErrorRate', {
      alarmName: 'garageos-api-lambda-errors',
      alarmDescription: 'Lambda error rate > 5% over 5 minutes',
      metric: new cloudwatch.MathExpression({
        expression: '(errors / invocations) * 100',
        usingMetrics: {
          errors: new cloudwatch.Metric({
            namespace: 'AWS/Lambda',
            metricName: 'Errors',
            dimensionsMap: lambdaDims,
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
          }),
          invocations: new cloudwatch.Metric({
            namespace: 'AWS/Lambda',
            metricName: 'Invocations',
            dimensionsMap: lambdaDims,
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
          }),
        },
      }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cw_actions.SnsAction(this.alertTopic));

    // Alarm: Lambda duration p95 > 3s
    new cloudwatch.Alarm(this, 'LambdaHighDuration', {
      alarmName: 'garageos-api-lambda-duration',
      alarmDescription: 'Lambda p95 duration > 3s over 5 minutes',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/Lambda',
        metricName: 'Duration',
        dimensionsMap: lambdaDims,
        statistic: 'p95',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 3000, // ms
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    }).addAlarmAction(new cw_actions.SnsAction(this.alertTopic));

    // Alarm: Throttles > 10 in 5 min (segnala saturazione reserved concurrency)
    new cloudwatch.Alarm(this, 'LambdaThrottles', {
      alarmName: 'garageos-api-lambda-throttles',
      alarmDescription: 'Lambda throttling events (reserved concurrency saturation)',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/Lambda',
        metricName: 'Throttles',
        dimensionsMap: lambdaDims,
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 10,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cw_actions.SnsAction(this.alertTopic));

    // Alarm: API Gateway 5xx > 10 in 5 min
    new cloudwatch.Alarm(this, 'ApiGateway5xx', {
      alarmName: 'garageos-api-apigw-5xx',
      alarmDescription: 'API Gateway 5xx responses (backend failures)',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApiGateway',
        metricName: '5xx',
        dimensionsMap: apiDims,
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 10,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cw_actions.SnsAction(this.alertTopic));

    // Dashboard
    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: 'GarageOS-Production',
    });

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'API Requests (Invocations)',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/Lambda',
            metricName: 'Invocations',
            dimensionsMap: lambdaDims,
            statistic: 'Sum',
          }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda Duration',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/Lambda',
            metricName: 'Duration',
            dimensionsMap: lambdaDims,
            statistic: 'p50',
            label: 'p50',
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/Lambda',
            metricName: 'Duration',
            dimensionsMap: lambdaDims,
            statistic: 'p95',
            label: 'p95',
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/Lambda',
            metricName: 'Duration',
            dimensionsMap: lambdaDims,
            statistic: 'p99',
            label: 'p99',
          }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'API Gateway Errors',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/ApiGateway',
            metricName: '4xx',
            dimensionsMap: apiDims,
            statistic: 'Sum',
            label: '4xx',
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/ApiGateway',
            metricName: '5xx',
            dimensionsMap: apiDims,
            statistic: 'Sum',
            label: '5xx',
          }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda Concurrency & Throttles',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/Lambda',
            metricName: 'ConcurrentExecutions',
            dimensionsMap: lambdaDims,
            statistic: 'Maximum',
            label: 'Concurrent (max)',
          }),
        ],
        right: [
          new cloudwatch.Metric({
            namespace: 'AWS/Lambda',
            metricName: 'Throttles',
            dimensionsMap: lambdaDims,
            statistic: 'Sum',
            label: 'Throttles',
          }),
        ],
      }),
    );
  }
}
```

### 5.12 OIDC Stack

```typescript
// lib/stacks/oidc-stack.ts
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';

interface OidcStackProps extends cdk.StackProps {
  githubOrg: string;
  githubRepo: string;
}

export class OidcStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: OidcStackProps) {
    super(scope, id, props);

    const provider = new iam.OpenIdConnectProvider(this, 'GitHubProvider', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });

    const deployRole = new iam.Role(this, 'DeployRole', {
      roleName: 'garageos-github-deploy',
      assumedBy: new iam.FederatedPrincipal(
        provider.openIdConnectProviderArn,
        {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          },
          StringLike: {
            'token.actions.githubusercontent.com:sub': `repo:${props.githubOrg}/${props.githubRepo}:*`,
          },
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('PowerUserAccess'),
      ],
      description: 'Role assumed by GitHub Actions for deployment',
    });

    new cdk.CfnOutput(this, 'DeployRoleArn', {
      value: deployRole.roleArn,
      description: 'Add this ARN to GitHub secrets as AWS_DEPLOY_ROLE_ARN',
    });
  }
}
```

---

## 6. Integrazione Supabase

### 6.1 Principio

Supabase è **gestito fuori da CDK** perché non è un servizio AWS. Lo si configura manualmente via dashboard Supabase, e le sue credenziali vengono fornite alla Lambda backend tramite Secrets Manager.

### 6.2 Setup Supabase (una tantum)

```
1. dashboard.supabase.com → New Project
2. Nome: garageos-production
3. Database password: generare password forte (32+ char), salvare in password manager
4. Region: eu-central-1 (Frankfurt)
5. Pricing Plan: Pro (già attivo)
6. Create project
7. Attendere 2-3 min per provisioning
```

### 6.3 Ottenere le connection string

```
Dashboard → Project Settings → Database

Copiare:
- URI "Transaction" (porta 6543) → DATABASE_URL
- URI "Session" (porta 5432) → DIRECT_URL

Sostituire [YOUR-PASSWORD] con la password reale.
```

### 6.4 Popolare Secrets Manager con le credenziali Supabase

Dopo il primo `cdk deploy`, aggiornare il Secret AWS con le credenziali vere:

```bash
aws secretsmanager update-secret \
    --secret-id garageos/production/app \
    --secret-string '{
      "DATABASE_URL": "postgres://postgres.xxx:password@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?pgbouncer=true",
      "DIRECT_URL": "postgres://postgres.xxx:password@aws-0-eu-central-1.pooler.supabase.com:5432/postgres",
      "SENTRY_DSN": "https://...",
      "EXPO_ACCESS_TOKEN": "..."
    }'
```

La Lambda leggerà il secret all'avvio (cold start) una volta sola per invocazione container — vedi §8.3 per il caching applicativo.

### 6.5 Network isolation Supabase

Supabase supporta **IP allowlist** per restringere chi può connettersi al DB. **Limitazione attuale**: la Lambda gira **fuori da VPC** (scelta esplicita per evitare cold start ENI di ~1-2s), quindi esce su internet con IP dinamici del pool AWS, senza IP statico. In v1 si lascia **allow-all** e ci si affida a:

- TLS obbligatorio
- Password DB forte ruotabile
- Autenticazione role-level (il backend usa solo ruolo applicativo, non il superuser)

**Roadmap v1.1**: valutare Lambda dentro VPC privata + NAT Gateway con IP statico (Elastic IP) + allowlist Supabase (~32€/mese NAT + penalty cold start iniziale). Da attivare solo se emergono requisiti di conformità aggiuntivi.

### 6.6 Applicare schema Prisma e RLS su Supabase

Prima del primo deploy applicativo:

```bash
# Dalla macchina del developer, con DATABASE_URL/DIRECT_URL configurati
pnpm --filter @garageos/database db:migrate:deploy
pnpm --filter @garageos/database db:rls:apply
pnpm --filter @garageos/database db:triggers:apply
pnpm --filter @garageos/database db:seed
```

Alternativa: eseguire da GitHub Actions con secret temporaneo (più sicuro del laptop developer).

---

## 7. Dominio e DNS

### 7.1 Registrazione dominio via Route 53

**Prima del `cdk deploy`, registrare il dominio:**

```
Route 53 Console → Registered domains → Register domain
Nome: garageos.it
Durata: 1 anno ($13/year circa)
Contact info: aziendali
Privacy protection: abilitata
Payment: carta registrata nell'account
```

Attendere 15-30 min per attivazione. Viene creata automaticamente una Hosted Zone associata.

### 7.2 Subdomain strategy

```
garageos.it              → landing page marketing (separata, v1.1)
app.garageos.it          → web app officine
api.garageos.it          → backend API
mail.garageos.it         → mail-from SES (record DKIM)
```

### 7.3 Associazione custom domain ad API Gateway

Il custom domain `api.garageos.it` è gestito **interamente da CDK** via `aws-cdk-lib/aws-apigatewayv2`:

- `apigw.DomainName` crea il domain name regionale con il certificato ACM (vedi §5.9.1)
- `apigw.HttpApi.defaultDomainMapping` lega il domain al default stage
- `route53.ARecord` + `route53Targets.ApiGatewayv2DomainProperties` crea l'A record alias

Nessuno step manuale post-deploy. Al primo `cdk deploy`, il certificato ACM viene validato via DNS record auto-creati dal `DnsConstruct`; tempi tipici: 5-10 minuti.

> **Nota storica:** in v1.0 (runtime App Runner) il custom domain richiedeva una procedura `aws apprunner associate-custom-domain` post-deploy. Rimossa in v1.1 — CDK gestisce tutto il ciclo.

### 7.4 SPF, DKIM, DMARC per SES

Per deliverability email ottimale, dopo aver verificato l'identity SES:

```
Record TXT @ garageos.it:
  "v=spf1 include:amazonses.com -all"

DKIM: gestito automaticamente da SES (3 record CNAME)

Record TXT _dmarc.garageos.it:
  "v=DMARC1; p=quarantine; rua=mailto:dmarc@garageos.it"
```

CDK può creare questi record automaticamente nel `DnsConstruct`.

---

## 8. Gestione secrets

### 8.1 Lista completa secret in Secrets Manager

| Secret name | Contenuto | Quando si popola |
|---|---|---|
| `garageos/production/app` | DATABASE_URL, DIRECT_URL, SENTRY_DSN, EXPO_ACCESS_TOKEN | Post setup Supabase + Sentry + Expo |
| `garageos/production/eventbridge-hmac` | Random 64-char HMAC key | Auto-generato da CDK |
| `garageos/production/ses-smtp` | SES SMTP credentials (se servono) | Solo se non usiamo SDK |

### 8.2 Secret rotation

**In v1**: rotation manuale trimestrale.
**In v1.1+**: automazione via Secrets Manager rotation con Lambda custom (sincronizza la rotazione sia in AWS che in Supabase).

### 8.3 Accesso secret dal backend

Il backend Fastify, all'avvio, legge il secret e popola `process.env`:

```typescript
// packages/api/src/config/secrets.ts
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const client = new SecretsManagerClient({ region: process.env.AWS_REGION });

export async function loadSecrets() {
  const secretArn = process.env.APP_SECRETS_ARN;
  if (!secretArn) throw new Error('APP_SECRETS_ARN not set');

  const response = await client.send(
    new GetSecretValueCommand({ SecretId: secretArn })
  );

  const secrets = JSON.parse(response.SecretString!);

  // Popola env per uso successivo
  process.env.DATABASE_URL = secrets.DATABASE_URL;
  process.env.DIRECT_URL = secrets.DIRECT_URL;
  process.env.SENTRY_DSN = secrets.SENTRY_DSN;
  process.env.EXPO_ACCESS_TOKEN = secrets.EXPO_ACCESS_TOKEN;
}
```

Da chiamare in `main.ts` PRIMA di inizializzare Prisma, Sentry, ecc.

---

## 9. Pipeline CI/CD

### 9.1 Workflow principale — `.github/workflows/deploy.yml`

```yaml
name: Deploy to production

on:
  push:
    branches: [main]
  workflow_dispatch:  # Permette trigger manuale

permissions:
  id-token: write
  contents: read

concurrency:
  group: deploy-production
  cancel-in-progress: false

jobs:
  lint-and-test:
    uses: ./.github/workflows/ci.yml  # Riusa il workflow CI (vedi Appendice E)

  deploy-infrastructure:
    needs: lint-and-test
    runs-on: ubuntu-latest
    environment: production  # Richiede manual approval
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}
          aws-region: eu-central-1

      # `cdk deploy` esegue il bundling esbuild del backend e aggiorna
      # la Lambda in-place. Nessun step separato docker/ECR: l'artifact
      # di deploy è uno zip CDK (tree-shaken, minified, ~5-15 MB).
      # Build time atteso: 30-60s vs 3-5 min del vecchio docker build.
      - name: Deploy CDK (infrastructure + Lambda code)
        run: pnpm --filter infrastructure exec cdk deploy --require-approval never --all

  run-migrations:
    needs: deploy-infrastructure
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}
          aws-region: eu-central-1

      - name: Fetch DATABASE_URL from Secrets Manager
        id: secrets
        run: |
          SECRET=$(aws secretsmanager get-secret-value --secret-id garageos/production/app --query SecretString --output text)
          echo "DATABASE_URL=$(echo $SECRET | jq -r '.DATABASE_URL')" >> $GITHUB_ENV
          echo "DIRECT_URL=$(echo $SECRET | jq -r '.DIRECT_URL')" >> $GITHUB_ENV

      - name: Apply migrations
        run: pnpm --filter @garageos/database db:migrate:deploy

  deploy-web-app:
    needs: [deploy-infrastructure, run-migrations]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile

      - name: Build web app
        run: pnpm --filter web-app build
        env:
          VITE_API_URL: https://api.garageos.it
          VITE_COGNITO_POOL_ID: ${{ vars.COGNITO_OFFICINE_POOL_ID }}
          VITE_COGNITO_CLIENT_ID: ${{ vars.COGNITO_OFFICINE_CLIENT_ID }}

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}
          aws-region: eu-central-1

      - name: Sync to S3
        run: |
          aws s3 sync packages/web-app/dist/ s3://garageos-production-webapp/ \
            --delete \
            --cache-control "public, max-age=31536000, immutable" \
            --exclude "index.html"
          aws s3 cp packages/web-app/dist/index.html s3://garageos-production-webapp/ \
            --cache-control "no-cache, no-store, must-revalidate"

      - name: Invalidate CloudFront
        run: |
          aws cloudfront create-invalidation \
            --distribution-id ${{ secrets.CLOUDFRONT_DISTRIBUTION_ID }} \
            --paths "/*"

  smoke-test:
    needs: [deploy-web-app, deploy-infrastructure]
    runs-on: ubuntu-latest
    steps:
      - name: Test API health
        run: |
          for i in {1..10}; do
            if curl -sf https://api.garageos.it/health; then
              echo "✅ API is healthy"
              exit 0
            fi
            echo "Waiting for API... attempt $i/10"
            sleep 30
          done
          echo "❌ API did not become healthy"
          exit 1

      - name: Test web app
        run: |
          curl -sf -o /dev/null -w "%{http_code}" https://app.garageos.it/ | grep 200
```

### 9.2 Deploy mobile app (EAS)

Separato dal workflow web, perché richiede approvazione store:

```yaml
# .github/workflows/mobile-build.yml
name: Build mobile app (EAS)

on:
  workflow_dispatch:
    inputs:
      platform:
        description: 'Platform to build'
        required: true
        default: 'all'
        type: choice
        options: [ios, android, all]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile

      - uses: expo/expo-github-action@v8
        with:
          eas-version: latest
          token: ${{ secrets.EXPO_TOKEN }}

      - name: Build iOS
        if: github.event.inputs.platform == 'ios' || github.event.inputs.platform == 'all'
        run: eas build --platform ios --profile production --non-interactive

      - name: Build Android
        if: github.event.inputs.platform == 'android' || github.event.inputs.platform == 'all'
        run: eas build --platform android --profile production --non-interactive
```

---

## 10. Procedure operative

### 10.1 Primo deploy end-to-end

**Ordine delle operazioni (una tantum):**

1. Creare account AWS, configurare MFA, IAM user admin, budget alert
2. Creare GitHub organization e repo `garageos-app`
3. Registrare dominio `garageos.it` via Route 53
4. Eseguire `cdk bootstrap`:
   ```bash
   pnpm --filter infrastructure exec cdk bootstrap aws://ACCOUNT_ID/eu-central-1
   ```
5. Deploy OIDC stack (per abilitare GitHub Actions):
   ```bash
   pnpm --filter infrastructure exec cdk deploy GarageosOidcStack
   ```
6. Copiare il `DeployRoleArn` nei GitHub secrets
7. Creare progetto Supabase (production)
8. Eseguire primo deploy manuale dello stack principale:
   ```bash
   pnpm --filter infrastructure exec cdk deploy GarageosMainStack
   ```
9. Popolare Secrets Manager con credenziali Supabase, Sentry, Expo (vedi §8)
10. Applicare schema DB su Supabase:
    ```bash
    pnpm --filter @garageos/database db:migrate:deploy
    pnpm --filter @garageos/database db:rls:apply
    pnpm --filter @garageos/database db:triggers:apply
    pnpm --filter @garageos/database db:seed
    ```
11. Rilanciare `cdk deploy` dopo aver popolato i secret (CDK farà un update della Lambda con il codice applicativo aggiornato):
    ```bash
    pnpm --filter infrastructure exec cdk deploy GarageosMainStack
    ```
    Il custom domain `api.garageos.it` è già attivo — CDK lo ha creato in §7.3.
12. Richiedere SES production access
13. Test: `curl https://api.garageos.it/health` → 200
14. Smoke test UI: aprire `https://app.garageos.it`

### 10.2 Deploy incrementale

Post setup iniziale, il flusso standard è:

1. Developer merge PR su `main`
2. GitHub Actions triggera `deploy.yml`
3. CI: lint + test + typecheck (da Appendice E)
4. `cdk deploy` aggiorna contemporaneamente infrastruttura e **codice Lambda** (bundling esbuild tramite `NodejsFunction` L2 — zip minified ~5-15 MB)
5. Run migrations (se ci sono)
6. Deploy web app su S3 + invalidate CloudFront
7. Smoke test

Tempo totale: ~5-10 min (30-60s il bundling esbuild vs 3-5 min del vecchio docker build).

**Nota aggiornamenti solo-codice applicativo**: se è cambiato solo il contenuto di `packages/api/src/` senza modifiche infrastrutturali, CDK rileva il diff e aggiorna **solo la Lambda** (~10-20s). La blue/green deployment non serve: Lambda usa versions + aliases per rollback istantaneo.

---

## 11. Cost monitoring

### 11.1 Budget alert CDK

Aggiungere al main stack:

```typescript
import * as budgets from 'aws-cdk-lib/aws-budgets';

new budgets.CfnBudget(this, 'MonthlyBudget', {
  budget: {
    budgetName: 'garageos-monthly',
    budgetType: 'COST',
    timeUnit: 'MONTHLY',
    budgetLimit: { amount: 150, unit: 'EUR' },
  },
  notificationsWithSubscribers: [
    {
      notification: {
        notificationType: 'ACTUAL',
        comparisonOperator: 'GREATER_THAN',
        threshold: 80,
      },
      subscribers: [
        { subscriptionType: 'EMAIL', address: 'admin@garageos.it' },
      ],
    },
    {
      notification: {
        notificationType: 'FORECASTED',
        comparisonOperator: 'GREATER_THAN',
        threshold: 100,
      },
      subscribers: [
        { subscriptionType: 'EMAIL', address: 'admin@garageos.it' },
      ],
    },
  ],
});
```

### 11.2 Cost allocation tags

Tag comuni applicati a tutte le risorse (via `cdk.Tags`):

```typescript
cdk.Tags.of(app).add('Project', 'garageos');
cdk.Tags.of(app).add('Environment', 'production');
cdk.Tags.of(app).add('ManagedBy', 'cdk');
```

In Cost Explorer si può raggruppare per questi tag per capire dove va il budget.

### 11.3 Review mensile

Ogni primo del mese:

1. AWS Billing → Cost Explorer → ultimi 30 giorni
2. Identificare top 5 servizi per costo
3. Confrontare con baseline (vedi §5.13 del master)
4. Se deviazione >20%, investigare

### 11.4 Stime costi backend runtime (Lambda + API Gateway)

Stime aggiornate al 2026-04-23, region `eu-central-1`, architecture `arm64`, memory 1024 MB, durata media invocazione ~150 ms. Tasso di conversione USD→EUR ~0.92 (stabile).

| Scenario | Req/mese | Lambda | API Gateway HTTP | CloudWatch | Data Transfer | **Totale** |
|---|---|---|---|---|---|---|
| Pilota basso | ~100k | 0,00 € | 0,09 € | 0,23 € | 0,17 € | **~0,45 € (~$0,50)** |
| Pilota medio | ~300k | 0,00 € | 0,28 € | 0,70 € | 0,50 € | **~1,50 € (~$1,60)** |
| Pilota alto | ~800k | 0,00 € | 0,74 € | 1,84 € | 1,24 € | **~3,85 € (~$4,15)** |
| Oltre pilota | ~3M | 0,98 € | 2,76 € | 6,90 € | 4,97 € | **~15,70 € (~$17,00)** |

**Osservazioni:**

- **Lambda compute resta dentro free tier** fino a ~2M req/mese con config 1 GB / 150 ms: Lambda vero inizia a costare solo oltre il pilota.
- Al pilota la voce dominante è **CloudWatch Logs**. Già ottimizzata con log retention 7 giorni (`logs.RetentionDays.ONE_WEEK` sul Lambda log group e sull'APIGW access log). Ulteriore riduzione possibile alzando il log level a `INFO` (oggi `DEBUG` in sviluppo, `INFO` in produzione).
- **API Gateway HTTP API v2** costa $1.00 per milione di richieste vs $3.50 del REST API v1 (~70% in meno a parità di funzionalità per il nostro caso d'uso).
- **Data transfer out**: stimato 2 KB/response media × volume × $0.09/GB.
- **Non sono inclusi**: Supabase Pro ($25/mese), S3 (~1-5€/mese), Route 53 (~0,50€/zone/mese + queries), CloudFront (~1-10€/mese), Cognito (free tier fino 10k MAU), SES production (~0,10€/1000 email). Questi valori restano invariati rispetto alla v1.0 del documento.

**Confronto con runtime App Runner v1.0** (pilota medio ~300k req):
- App Runner 1 vCPU / 2 GB in always-on: ~30-45 €/mese
- Lambda + APIGW HTTP: ~1,50 €/mese
- **Risparmio: 20-30× al pilota**, decrescente all'aumentare del volume (si pareggia intorno a ~10M req/mese).

---

## 12. Rollback strategy

### 12.1 Rollback backend API

**Scenario:** nuova versione ha bug critico in produzione.

Lambda mantiene lo storico delle versioni immutabili (ogni `cdk deploy` crea una nuova version se usiamo `currentVersion`). Due strategie, dalla più veloce alla più "pulita":

**Opzione A — Rollback immediato via alias (tempo: ~10 secondi)**

Se la Lambda è dietro un alias `live` che punta a una version specifica, basta ripuntare l'alias alla version precedente:

```bash
# 1. Identificare la version precedente
aws lambda list-versions-by-function --function-name garageos-api

# 2. Ripuntare l'alias `live` alla version precedente
aws lambda update-alias \
    --function-name garageos-api \
    --name live \
    --function-version <N-1>
```

API Gateway → Lambda alias = traffic cutover istantaneo.

**Opzione B — Rollback via CDK deploy (tempo: ~3-5 minuti)**

```bash
# Checkout del commit precedente + redeploy CDK
git checkout <commit-precedente>
pnpm --filter infrastructure exec cdk deploy GarageosMainStack
```

CDK ribundleaIl codice del commit vecchio e aggiorna la Lambda. Più lento dell'opzione A ma coerente con lo stato CDK (evita drift).

> **Roadmap v1.1**: abilitare Lambda alias `live` + routing weighted per canary deploy (es. 10% traffico sulla nuova version, promotion dopo 10 min se alarms verdi).

### 12.2 Rollback web app

CloudFront serve file versionati da S3. Rollback:

```bash
# Checkout del commit precedente e redeploy
git checkout <commit-precedente>
pnpm --filter web-app build
aws s3 sync packages/web-app/dist/ s3://garageos-production-webapp/ --delete
aws cloudfront create-invalidation --distribution-id <id> --paths "/*"
```

**Tempo rollback:** ~2 minuti.

### 12.3 Rollback database (PITR Supabase)

Se una migration corrompe i dati:

1. Dashboard Supabase → Database → Backups
2. Selezionare timestamp PRE-migration
3. "Restore in place" OPPURE "Create new project from this point"
4. Se nuovo progetto: aggiornare `DATABASE_URL` in Secrets Manager
5. Rilanciare `cdk deploy` (o `aws lambda update-function-configuration` per forzare cold start e rilettura dei secret)

**Tempo restore:** ~5-30 min (dipende dalla dimensione DB).

**Regola d'oro:** ogni migration destructive (DROP COLUMN, DROP TABLE) è preceduta da verifica e **backup manuale su S3** prima del deploy. Vedi Appendice B §8.

### 12.4 Rollback infrastruttura CDK

```bash
# Checkout del branch precedente
git checkout <commit-precedente>
pnpm --filter infrastructure exec cdk deploy --all
```

CDK rileva le differenze e applica i cambiamenti necessari per tornare allo stato precedente.

**Attenzione:** modifiche distruttive (es. rimozione di risorse) potrebbero non essere reversibili (es. contenuti S3 già cancellati). Per questo tutte le risorse stateful hanno `RemovalPolicy.RETAIN`.

---

## 13. Checklist pre-go-live

Prima del lancio pilota:

- [ ] Account AWS con MFA, budget alert attivi
- [ ] Dominio `garageos.it` registrato e DNS funzionante
- [ ] SES production access approvato
- [ ] Certificate SSL attivi (api, app)
- [ ] Supabase project in EU region, password forte in Secrets Manager
- [ ] Schema DB applicato, RLS policies attive, seed eseguito
- [ ] Lambda `garageos-api` running, API Gateway HTTP API v2 configurato, custom domain `api.garageos.it` attivo (gestito via CDK)
- [ ] Warming schedule EventBridge attivo (`cron(*/5 8-20 ? * MON-SAT *)` Europe/Rome)
- [ ] Cognito user pools creati, configurati in frontend
- [ ] S3 bucket allegati configurato con CORS, lifecycle
- [ ] WAF attivo e monitorato
- [ ] CloudWatch alarms funzionanti, SNS subscription attiva
- [ ] Sentry project configurato, DSN in secrets
- [ ] Expo EAS configurato, app build testato
- [ ] GitHub Actions OIDC role funzionante
- [ ] Primo deploy end-to-end eseguito con successo
- [ ] Smoke test manuale superato (vedi Appendice E §12)
- [ ] Runbook operativo documentato
- [ ] Email admin@garageos.it monitorato attivamente
- [ ] DPIA firmato, DPA con subprocessor (AWS, Supabase) in ordine

---

## 14. Checklist per Claude Code

Quando Claude Code deve lavorare sull'infrastruttura:

1. [ ] Verificare di essere sul branch corretto prima di `cdk deploy`
2. [ ] Eseguire `cdk diff` prima di ogni deploy per verificare cambiamenti
3. [ ] Non mai mettere secret hardcoded nel codice CDK
4. [ ] Usare `RemovalPolicy.RETAIN` su risorse stateful (S3, Secrets, Cognito)
5. [ ] Aggiungere tag `Project: garageos`, `Environment: production` a tutte le risorse
6. [ ] Per cambiamenti distruttivi: testare prima con `cdk deploy --hotswap=false`
7. [ ] Documentare ogni nuovo secret in questa appendice §8
8. [ ] Aggiornare runbook se si introduce nuova procedura operativa

---

*Fine Appendice C — Infrastructure*
