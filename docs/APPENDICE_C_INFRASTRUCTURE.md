# Appendice C — Infrastructure

> **Documento correlato:** questo è un'appendice del documento principale `GarageOS-Specifiche.md`. Definisce l'infrastruttura AWS via CDK, il setup GitHub, le procedure di deployment e gestione ambienti.
>
> **Versione:** v1.0 — allineata a `GarageOS-Specifiche.md` v1.5
> **Ultimo aggiornamento:** 22 aprile 2026

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
| **App Runner** | Backend Fastify | Main stack |
| **Cognito** | Two User Pool (officine, clienti) | Main stack |
| **S3** | Allegati + Tag PDF | Main stack |
| **CloudFront** | CDN asset web app | Main stack |
| **Route 53** | DNS + registrar dominio | Main stack |
| **Certificate Manager** | SSL certs | Main stack |
| **WAF** | Protezione API | Main stack |
| **EventBridge Scheduler** | Promemoria scadenze | Main stack |
| **SES** | Email transazionali | Main stack |
| **Secrets Manager** | Secrets applicativi | Main stack |
| **CloudWatch** | Logs + metrics + alarms | Main stack |
| **IAM** | Ruoli e policy | Main stack |
| **ECR** | Container registry per App Runner | Main stack |

**Servizi esterni ad AWS** (non gestiti via CDK):
- **Supabase** — PostgreSQL managed (gestito via dashboard Supabase)
- **Expo Push Service** — gestito via Expo dashboard
- **Sentry** — gestito via Sentry dashboard

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
│   │   ├── app-runner.ts        # Construct custom per App Runner
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
  appRunner: {
    cpu: '1 vCPU' | '2 vCPU';
    memory: '2 GB' | '4 GB';
    autoScalingMaxConcurrency: number;
    autoScalingMaxSize: number;
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
  appRunner: {
    cpu: '1 vCPU',
    memory: '2 GB',
    autoScalingMaxConcurrency: 100,
    autoScalingMaxSize: 5,
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
import { AppRunnerConstruct } from '../constructs/app-runner';
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

    // 7. App Runner (backend API)
    const apiService = new AppRunnerConstruct(this, 'ApiService', {
      config,
      attachmentsBucket: storage.attachmentsBucket,
      cognitoPoolOfficine: cognito.officineUserPool,
      cognitoPoolClienti: cognito.clientiUserPool,
      secrets: secrets.appSecrets,
      hostedZone: dns.hostedZone,
      certificate: dns.apiCertificate,
    });

    // 8. EventBridge Scheduler
    const scheduler = new SchedulerConstruct(this, 'Scheduler', {
      appRunnerServiceUrl: apiService.serviceUrl,
      hmacSecret: secrets.eventbridgeHmacSecret,
    });

    // 9. Monitoring (CloudWatch alarms)
    new MonitoringConstruct(this, 'Monitoring', {
      apiService: apiService.service,
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
      selfSignUpEnabled: true,
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

    // HMAC secret per auth endpoints interni (EventBridge → App Runner)
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

### 5.9 Construct: App Runner

```typescript
// lib/constructs/app-runner.ts
import { Construct } from 'constructs';
import * as apprunner from 'aws-cdk-lib/aws-apprunner';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cdk from 'aws-cdk-lib';
import { EnvironmentConfig } from '../config/production';

interface AppRunnerProps {
  config: EnvironmentConfig;
  attachmentsBucket: s3.IBucket;
  cognitoPoolOfficine: cognito.IUserPool;
  cognitoPoolClienti: cognito.IUserPool;
  secrets: secretsmanager.ISecret;
  hostedZone: route53.IHostedZone;
  certificate: acm.ICertificate;
}

export class AppRunnerConstruct extends Construct {
  public readonly service: apprunner.CfnService;
  public readonly serviceUrl: string;
  public readonly ecrRepo: ecr.Repository;

  constructor(scope: Construct, id: string, props: AppRunnerProps) {
    super(scope, id);

    // ECR repo per l'immagine Docker del backend
    this.ecrRepo = new ecr.Repository(this, 'ApiRepo', {
      repositoryName: 'garageos-api',
      imageScanOnPush: true,
      lifecycleRules: [
        { maxImageCount: 10 },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // IAM role for App Runner tasks
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('tasks.apprunner.amazonaws.com'),
    });

    // Permissions: read S3, access Cognito, read secrets, publish EventBridge schedules
    props.attachmentsBucket.grantReadWrite(taskRole);
    props.secrets.grantRead(taskRole);

    taskRole.addToPolicy(new iam.PolicyStatement({
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

    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'scheduler:CreateSchedule',
        'scheduler:DeleteSchedule',
        'scheduler:UpdateSchedule',
        'scheduler:GetSchedule',
      ],
      resources: ['*'],
    }));

    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: ['*'],
    }));

    // Access role per App Runner (pull da ECR)
    const accessRole = new iam.Role(this, 'AccessRole', {
      assumedBy: new iam.ServicePrincipal('build.apprunner.amazonaws.com'),
    });
    this.ecrRepo.grantPull(accessRole);

    // App Runner service
    this.service = new apprunner.CfnService(this, 'Service', {
      serviceName: 'garageos-api',
      sourceConfiguration: {
        autoDeploymentsEnabled: true,
        authenticationConfiguration: {
          accessRoleArn: accessRole.roleArn,
        },
        imageRepository: {
          imageIdentifier: `${this.ecrRepo.repositoryUri}:latest`,
          imageRepositoryType: 'ECR',
          imageConfiguration: {
            port: '3000',
            runtimeEnvironmentVariables: [
              { name: 'NODE_ENV', value: 'production' },
              { name: 'AWS_REGION', value: 'eu-central-1' },
              { name: 'ATTACHMENTS_BUCKET', value: props.attachmentsBucket.bucketName },
              { name: 'COGNITO_OFFICINE_POOL_ID', value: props.cognitoPoolOfficine.userPoolId },
              { name: 'COGNITO_CLIENTI_POOL_ID', value: props.cognitoPoolClienti.userPoolId },
              { name: 'APP_SECRETS_ARN', value: props.secrets.secretArn },
            ],
          },
        },
      },
      instanceConfiguration: {
        cpu: props.config.appRunner.cpu,
        memory: props.config.appRunner.memory,
        instanceRoleArn: taskRole.roleArn,
      },
      healthCheckConfiguration: {
        protocol: 'HTTP',
        path: '/health',
        interval: 10,
        timeout: 5,
        healthyThreshold: 1,
        unhealthyThreshold: 3,
      },
      autoScalingConfigurationArn: new apprunner.CfnAutoScalingConfiguration(this, 'AutoScaling', {
        autoScalingConfigurationName: 'garageos-api-autoscaling',
        maxConcurrency: props.config.appRunner.autoScalingMaxConcurrency,
        maxSize: props.config.appRunner.autoScalingMaxSize,
        minSize: 1,
      }).attrAutoScalingConfigurationArn,
    });

    this.serviceUrl = `https://${this.service.attrServiceUrl}`;

    // Custom domain association (api.garageos.it → App Runner)
    new apprunner.CfnService.ServiceProperty; // placeholder
    // Note: CDK L1 per custom domain association è limitato,
    // va configurato post-deploy via AWS CLI oppure Custom Resource.
    // Vedi §10.3 per procedura.
  }
}
```

### 5.10 Construct: Scheduler

```typescript
// lib/constructs/scheduler.ts
import { Construct } from 'constructs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

interface SchedulerProps {
  appRunnerServiceUrl: string;
  hmacSecret: secretsmanager.ISecret;
}

export class SchedulerConstruct extends Construct {
  public readonly schedulerRole: iam.Role;
  public readonly scheduleGroup: scheduler.CfnScheduleGroup;

  constructor(scope: Construct, id: string, props: SchedulerProps) {
    super(scope, id);

    // Schedule group dedicato per le scadenze
    this.scheduleGroup = new scheduler.CfnScheduleGroup(this, 'DeadlineGroup', {
      name: 'garageos-deadlines',
    });

    // Role usato da EventBridge per invocare l'endpoint HTTP
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
      },
    });

    // Individual schedules sono creati runtime dall'applicazione
    // tramite SchedulerClient SDK. Qui si prepara solo l'infrastruttura.
  }
}
```

### 5.11 Construct: Monitoring

```typescript
// lib/constructs/monitoring.ts
import { Construct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as apprunner from 'aws-cdk-lib/aws-apprunner';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as cdk from 'aws-cdk-lib';

interface MonitoringProps {
  apiService: apprunner.CfnService;
  attachmentsBucket: s3.IBucket;
  logRetentionDays: number;
}

export class MonitoringConstruct extends Construct {
  public readonly alertTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: MonitoringProps) {
    super(scope, id);

    // SNS topic per alert
    this.alertTopic = new sns.Topic(this, 'AlertTopic', {
      displayName: 'GarageOS Production Alerts',
    });

    // Add email subscription post-deploy (via console o CLI)

    // Log group retention
    const appRunnerLogGroup = new logs.LogGroup(this, 'ApiLogGroup', {
      logGroupName: `/aws/apprunner/garageos-api/application`,
      retention: props.logRetentionDays,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Alarm: 5xx error rate > 1% for 5 min
    new cloudwatch.Alarm(this, 'HighErrorRate', {
      alarmName: 'garageos-api-high-error-rate',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/AppRunner',
        metricName: '5xxStatusResponses',
        dimensionsMap: { ServiceName: 'garageos-api' },
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 10,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    }).addAlarmAction(new cw_actions.SnsAction(this.alertTopic));

    // Alarm: latency p99 > 2s
    new cloudwatch.Alarm(this, 'HighLatency', {
      alarmName: 'garageos-api-high-latency',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/AppRunner',
        metricName: 'RequestLatency',
        dimensionsMap: { ServiceName: 'garageos-api' },
        statistic: 'p99',
        period: cdk.Duration.minutes(10),
      }),
      threshold: 2000, // ms
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    }).addAlarmAction(new cw_actions.SnsAction(this.alertTopic));

    // Dashboard
    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: 'GarageOS-Production',
    });

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'API Requests',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/AppRunner',
            metricName: 'RequestCount',
            dimensionsMap: { ServiceName: 'garageos-api' },
            statistic: 'Sum',
          }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'API Latency',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/AppRunner',
            metricName: 'RequestLatency',
            dimensionsMap: { ServiceName: 'garageos-api' },
            statistic: 'p50',
            label: 'p50',
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/AppRunner',
            metricName: 'RequestLatency',
            dimensionsMap: { ServiceName: 'garageos-api' },
            statistic: 'p99',
            label: 'p99',
          }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'API Errors',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/AppRunner',
            metricName: '4xxStatusResponses',
            dimensionsMap: { ServiceName: 'garageos-api' },
            statistic: 'Sum',
            label: '4xx',
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/AppRunner',
            metricName: '5xxStatusResponses',
            dimensionsMap: { ServiceName: 'garageos-api' },
            statistic: 'Sum',
            label: '5xx',
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

Supabase è **gestito fuori da CDK** perché non è un servizio AWS. Lo si configura manualmente via dashboard Supabase, e le sue credenziali vengono fornite all'App Runner tramite Secrets Manager.

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

L'App Runner leggerà il secret al momento dell'avvio.

### 6.5 Network isolation Supabase

Supabase supporta **IP allowlist** per restringere chi può connettersi al DB. **Limitazione attuale**: App Runner non ha IP statico (scala orizzontalmente su IP diversi), quindi in v1 si lascia **allow-all** e ci si affida a:

- TLS obbligatorio
- Password DB forte ruotabile
- Autenticazione role-level (il backend usa solo ruolo applicativo, non il superuser)

**Roadmap v1.1**: valutare NAT Gateway con IP statico + allowlist Supabase (~32€/mese in più, maggiore sicurezza).

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

### 7.3 Associazione custom domain ad App Runner

App Runner custom domain **non è gestibile via CDK L2** (solo L1). Configurazione post-deploy:

```bash
# 1. Associate custom domain
aws apprunner associate-custom-domain \
    --service-arn <app-runner-service-arn> \
    --domain-name api.garageos.it \
    --enable-www-subdomain false

# 2. AWS restituisce DNS records da creare in Route 53
# (CDK o manualmente)

# 3. Verificare con:
aws apprunner describe-custom-domains --service-arn <arn>
```

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
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}
          aws-region: eu-central-1

      - name: Deploy CDK
        run: pnpm --filter infrastructure cdk deploy --require-approval never --all

  build-and-push-api:
    needs: deploy-infrastructure
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}
          aws-region: eu-central-1

      - name: Login to ECR
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build and push Docker image
        env:
          ECR_REGISTRY: ${{ steps.login-ecr.outputs.registry }}
          IMAGE_TAG: ${{ github.sha }}
        run: |
          docker build \
            -f packages/api/Dockerfile \
            -t $ECR_REGISTRY/garageos-api:$IMAGE_TAG \
            -t $ECR_REGISTRY/garageos-api:latest \
            .
          docker push $ECR_REGISTRY/garageos-api:$IMAGE_TAG
          docker push $ECR_REGISTRY/garageos-api:latest

      - name: Trigger App Runner deployment
        run: |
          aws apprunner start-deployment \
            --service-arn ${{ secrets.APP_RUNNER_SERVICE_ARN }}

  run-migrations:
    needs: deploy-infrastructure
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
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
    needs: [build-and-push-api, run-migrations]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
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
    needs: [deploy-web-app, build-and-push-api]
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
        with: { node-version: 20, cache: pnpm }
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
   pnpm --filter infrastructure cdk bootstrap aws://ACCOUNT_ID/eu-central-1
   ```
5. Deploy OIDC stack (per abilitare GitHub Actions):
   ```bash
   pnpm --filter infrastructure cdk deploy GarageosOidcStack
   ```
6. Copiare il `DeployRoleArn` nei GitHub secrets
7. Creare progetto Supabase (production)
8. Eseguire primo deploy manuale dello stack principale:
   ```bash
   pnpm --filter infrastructure cdk deploy GarageosMainStack
   ```
9. Popolare Secrets Manager con credenziali Supabase, Sentry, Expo (vedi §8)
10. Applicare schema DB su Supabase:
    ```bash
    pnpm --filter @garageos/database db:migrate:deploy
    pnpm --filter @garageos/database db:rls:apply
    pnpm --filter @garageos/database db:triggers:apply
    pnpm --filter @garageos/database db:seed
    ```
11. Build + push prima immagine Docker:
    ```bash
    ./scripts/build-push-api.sh
    aws apprunner start-deployment --service-arn <arn>
    ```
12. Richiedere SES production access
13. Associare custom domain ad App Runner (§7.3)
14. Test: `curl https://api.garageos.it/health` → 200
15. Smoke test UI: aprire `https://app.garageos.it`

### 10.2 Deploy incrementale

Post setup iniziale, il flusso standard è:

1. Developer merge PR su `main`
2. GitHub Actions triggera `deploy.yml`
3. CI: lint + test + typecheck (da Appendice E)
4. CDK deploy (se ci sono cambi infrastrutturali)
5. Build Docker + push ECR
6. App Runner start-deployment (blue/green automatico)
7. Run migrations (se ci sono)
8. Deploy web app su S3 + invalidate CloudFront
9. Smoke test

Tempo totale: ~10-15 min.

### 10.3 Custom domain association (procedura dettagliata)

Dopo il primo deploy App Runner, associare `api.garageos.it`:

```bash
# 1. Associate
aws apprunner associate-custom-domain \
    --service-arn $(aws apprunner list-services --query 'ServiceSummaryList[0].ServiceArn' --output text) \
    --domain-name api.garageos.it \
    --enable-www-subdomain false

# 2. Ottenere i record DNS da creare
aws apprunner describe-custom-domains \
    --service-arn <arn> \
    --query 'CustomDomains[0].CertificateValidationRecords'

# 3. Creare record CNAME in Route 53 (manuale o via CDK L1)
# Esempio:
aws route53 change-resource-record-sets \
    --hosted-zone-id <zone-id> \
    --change-batch file://dns-records.json

# 4. Verificare
aws apprunner describe-custom-domains --service-arn <arn>
# Stato: pending_certificate_dns_validation → active (dopo ~5-30 min)
```

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

---

## 12. Rollback strategy

### 12.1 Rollback backend API

**Scenario:** nuova versione ha bug critico in produzione.

App Runner mantiene lo storico delle deployment. Per rollback:

```bash
# 1. Identificare la deployment precedente
aws apprunner list-operations --service-arn <arn>

# 2. Rollback tramite redeploy dell'immagine precedente
# Tag immagine ECR con versioni (github.sha) permette di puntare a versione specifica
aws apprunner update-service \
    --service-arn <arn> \
    --source-configuration '{
      "ImageRepository": {
        "ImageIdentifier": "'<ECR>/garageos-api:<commit-precedente>'"
      }
    }'
```

**Tempo di rollback:** ~3-5 minuti (tempo deployment App Runner).

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
5. Rilanciare App Runner deployment

**Tempo restore:** ~5-30 min (dipende dalla dimensione DB).

**Regola d'oro:** ogni migration destructive (DROP COLUMN, DROP TABLE) è preceduta da verifica e **backup manuale su S3** prima del deploy. Vedi Appendice B §8.

### 12.4 Rollback infrastruttura CDK

```bash
# Checkout del branch precedente
git checkout <commit-precedente>
pnpm --filter infrastructure cdk deploy --all
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
- [ ] App Runner service running, custom domain associato
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
