# `infrastructure/` — GarageOS AWS deploy

CDK in TypeScript. Deploya il backend GarageOS su AWS in `eu-central-1`.

In v1 (PR 21+22): scaffolding minimo per il primo deploy live + auth.

- 1 stack OIDC separato (`GarageosOidcStack`)
- 1 stack principale (`GarageosMainStack`) con DNS + Secrets + Cognito + Lambda API + APIGW HTTP v2

PR successivi: Storage+WAF (PR 23), SES+Scheduler+Monitoring (PR 24), Web app S3+CloudFront (PR 25).

## Runbook — primo deploy end-to-end

> Eseguire questo runbook UNA SOLA VOLTA dopo il merge di PR 21. Subito dopo, GarageOS è raggiungibile via `https://api.garageos.it/health`.

### F1. Prerequisiti

- AWS account attivo con metodo di pagamento collegato
- AWS CLI v2 installato e configurato (`aws configure` con credenziali admin temporanee — verranno rimosse dopo lo step F4)
- Dominio `garageos.it` di proprietà
- Supabase production project attivo (Michele lo ha già — `DATABASE_URL` e `DATABASE_URL_DIRECT` nel password manager)
- Account GitHub con permessi admin sul repo

### F2. Step 1 — CDK bootstrap (una tantum per account+region)

```bash
pnpm --filter infrastructure exec cdk bootstrap aws://ACCOUNT_ID/eu-central-1
```

Sostituire `ACCOUNT_ID` con il numero account AWS (12 cifre).

Cosa crea: bucket S3 di staging + ruolo IAM per CDK assets. Niente costo a riposo.

### F3. Step 2 — Hosted zone Route 53

Due path:

**(a) Registrare il dominio via Route 53 (più semplice).**

1. Console AWS → Route 53 → Registered domains → Register domain
2. Cercare `garageos.it`, completare wizard (~13 USD/anno, privacy abilitata)
3. Attendere ~15-30 min per attivazione + propagazione NS
4. Hosted zone è creata in automatico

**(b) Dominio già registrato altrove.**

1. Console AWS → Route 53 → Hosted zones → Create hosted zone
2. Domain name `garageos.it`, Type Public
3. Copiare i 4 NS records della zone e aggiornarli al registrar di origine
4. Attendere propagazione (~24h max)

Verificare:

```bash
aws route53 list-hosted-zones-by-name --dns-name garageos.it --query 'HostedZones[0].Id'
```

Deve restituire un `/hostedzone/Z...` non vuoto.

### F4. Step 3 — Deploy OidcStack

```bash
pnpm --filter infrastructure exec cdk deploy GarageosOidcStack
```

Output stampa:

```
GarageosOidcStack.DeployRoleArn = arn:aws:iam::ACCOUNT_ID:role/garageos-github-deploy
```

Copiare l'ARN. Su GitHub:

1. Repo → Settings → Secrets and variables → Actions → New repository secret
   - Name: `AWS_DEPLOY_ROLE_ARN`
   - Value: l'ARN copiato sopra
2. Repo → Settings → Environments → New environment
   - Name: `production`
   - Required reviewers: Michele (yourself)

A questo punto il workflow `deploy.yml` può assumere il ruolo via OIDC senza access keys.

### F5. Step 4 — Verifica risoluzione hosted zone pre-deploy MainStack

`DnsConstruct.fromLookup` fallirà silenziosamente al `cdk deploy` se la hosted zone non è ancora resolvibile dal contesto CDK. Forza un refresh contesto:

```bash
rm -rf infrastructure/cdk.out infrastructure/cdk.context.json
pnpm --filter infrastructure exec cdk synth GarageosMainStack
```

Se c'è un errore "Hosted zone for garageos.it not found", attendere qualche minuto e ripetere.

### F6. Step 5 — Primo deploy MainStack (con secret placeholder)

```bash
pnpm --filter infrastructure exec cdk deploy GarageosMainStack
```

Tempo atteso: **10-15 minuti** (la voce più lenta è la validazione DNS del certificato ACM, 5-10 min). Mantenere il terminale aperto.

Output di interesse:

```
GarageosMainStack.ApiUrl = https://api.garageos.it
GarageosMainStack.HttpApiEndpoint = https://abc123.execute-api.eu-central-1.amazonaws.com
GarageosMainStack.LambdaFunctionArn = arn:aws:lambda:eu-central-1:...
GarageosMainStack.AppSecretsArn = arn:aws:secretsmanager:eu-central-1:...:secret:garageos/production/app-XXXXX
```

A questo punto la Lambda esiste, ma ogni request fallisce: il secret contiene il solo placeholder costante `{}` (JSON vuoto valido). La Lambda booterà ma `env.ts` fallirà la validazione elencando i campi mancanti — errore diagnosticabile, non un crash opaco.

> **Il valore del secret è gestito interamente fuori da CDK (operator-managed).** Il template CloudFormation ship SOLO il placeholder costante `{}`: `secrets.ts` non enumera più i campi. Motivo: CloudFormation riscrive il `SecretString` live ogni volta che il valore nel template cambia, quindi un tempo aggiungere un campo a `secretObjectValue` resettava l'INTERO secret ai placeholder al deploy successivo (outage #221). Con il placeholder costante, aggiungere/cambiare una credenziale non tocca mai il template. La **source of truth dell'elenco chiavi** è `packages/api/src/config/env.ts`; i 9 campi attuali sono nel JSON sotto.
>
> ⚠️ **Reset one-time alla migrazione verso il placeholder costante.** Il deploy che introduce per la prima volta il placeholder `{}` cambia il `SecretString` del template (prima era l'oggetto a 9 campi) → CloudFormation riscrive il secret live UNA volta. Su uno stack già popolato (prod) questo azzera i valori reali finché l'operatore non ri-esegue `put-secret-value`. Procedura: (1) `get-secret-value … --query SecretString --output text > good.json` PRIMA del deploy; (2) deploy; (3) `put-secret-value … --secret-string file://good.json`; (4) force cold-start (`aws lambda update-function-configuration --function-name garageos-api --description "repopulate"`); (5) verificare `/health` → `database: ok`. Se il deploy è già passato, recuperare da `--version-stage AWSPREVIOUS`. (Pinnare `AWS_REGION=eu-central-1`.)

### F7. Step 6 — Popolare Secrets Manager con valori reali

> NON incollare le credenziali in chat con Claude né in nessun file committato. Tenerle nel password manager.

Prima leggere i 4 ID Cognito dagli stack outputs (PR 22+ — se questo è il primissimo deploy pre-PR-22, saltare al placeholder JSON in fondo):

```bash
aws cloudformation describe-stacks \
  --stack-name GarageosMainStack \
  --region eu-central-1 \
  --query 'Stacks[0].Outputs[?starts_with(OutputKey, `Cognito`)].[OutputKey,OutputValue]' \
  --output table
```

Output atteso: tabella con 4 righe (`CognitoOfficineUserPoolId`, `CognitoOfficineClientId`, `CognitoClientiUserPoolId`, `CognitoClientiClientId`) — annota i valori.

Estrarre dal password manager le due connection string Supabase, **rinominando `DATABASE_URL_DIRECT` → `DIRECT_URL`** (env.ts richiede `DIRECT_URL`, non `DATABASE_URL_DIRECT`).

```bash
aws secretsmanager put-secret-value \
  --secret-id garageos/production/app \
  --region eu-central-1 \
  --secret-string '{
    "DATABASE_URL": "<incollare DATABASE_URL Supabase>",
    "DIRECT_URL": "<incollare DATABASE_URL_DIRECT Supabase>",
    "COGNITO_OFFICINE_POOL_ID": "<CognitoOfficineUserPoolId>",
    "COGNITO_OFFICINE_CLIENT_ID": "<CognitoOfficineClientId>",
    "COGNITO_CLIENTI_POOL_ID": "<CognitoClientiUserPoolId>",
    "COGNITO_CLIENTI_CLIENT_ID": "<CognitoClientiClientId>",
    "COGNITO_PLATFORM_ADMINS_POOL_ID": "<CognitoPlatformAdminsUserPoolId>",
    "COGNITO_PLATFORM_ADMINS_CLIENT_ID": "<CognitoPlatformAdminsClientId>",
    "RESEND_API_KEY": "<chiave API Resend — provider email transazionali per inviti officine e onboarding tenant>",
    "SENTRY_DSN": "https://placeholder@sentry.io/0"
  }'
```

> Includere SEMPRE tutti i 10 campi: `put-secret-value` (come `update-secret --secret-string`) sostituisce l'INTERO valore, non fa merge. Per recuperare i valori reali dopo un reset, leggere l'ultima versione buona con `aws secretsmanager get-secret-value --secret-id garageos/production/app --version-stage AWSPREVIOUS` (o `--version-id <id>` dalla version-history).

> Pre-PR-22 fallback: usare placeholder `eu-central-1_PLACEHOLDER` / `PLACEHOLDER` per i 4 ID Cognito. Soddisfano il regex di `env.ts` ma puntano a pool inesistenti — la Lambda booterà ma le route auth-protected falliranno con `5xx`. Solo `/health` (auth-free) funzionerà. NON usare questo path se PR 22 è già in main.

### F7.5. Step 6.5 — Bootstrap del primo super_admin officine (one-off)

> **Eseguire una sola volta**, dopo F7+F8 con i 4 valori reali Cognito. Crea un tenant seed in DB + un Cognito user super_admin per smoke test end-to-end auth. Da PR 22+; non applicabile pre-PR-22.

#### F7.5.a — Inserire un tenant seed in Supabase (SQL diretto)

Eseguire dal Supabase SQL Editor o psql collegato al production project. I campi obbligatori sono `business_name`, `vat_number`, `email` (3 NOT NULL senza default DB) **+ `updated_at`**: lo schema Prisma marca `updatedAt` come `@updatedAt`, ma quella è logica applicativa lato Prisma client — il raw SQL bypassa Prisma e deve fornire il valore esplicitamente, altrimenti l'INSERT fallisce con `null value in column "updated_at" of relation "tenants" violates not-null constraint`. Gli altri campi prendono i default da `packages/database/prisma/schema.prisma` model `Tenant` (`status='active'`, `billing_status='manual'`, `plan='starter'`, `settings='{}'`, `id=gen_random_uuid()`, `created_at=now()`).

```sql
INSERT INTO tenants (business_name, vat_number, email, updated_at)
VALUES (
  'Officina Bootstrap',
  'IT00000000001',
  'admin@example.com',
  now()
)
RETURNING id;
```

> Annota l'`id` UUID restituito. Serve per `custom:tenant_id` in F7.5.b.
> Nota: `tenants` NON ha colonna `garage_code` (quel field è su `vehicles` per BR-020). Il tenant di bootstrap non ne ha bisogno — il PR onboarding futuro assegnerà `garage_code` ai veicoli registrati nel tenant.

#### F7.5.b — `aws cognito-idp admin-create-user`

```bash
OFFICINE_POOL="<CognitoOfficineUserPoolId — dal table di F7>"
TENANT_ID="<UUID generato da F7.5.a>"
ADMIN_EMAIL="admin@example.com"   # email reale per ricevere l'invito
TEMP_PASSWORD="ChangeMe-XYZ-2026!"  # forte, lower+upper+digit, min 10 char

aws cognito-idp admin-create-user \
  --user-pool-id "$OFFICINE_POOL" \
  --username "$ADMIN_EMAIL" \
  --user-attributes \
    Name=email,Value="$ADMIN_EMAIL" \
    Name=email_verified,Value=true \
    Name=given_name,Value=Admin \
    Name=family_name,Value=Bootstrap \
    Name=custom:tenant_id,Value="$TENANT_ID" \
    Name=custom:role,Value=super_admin \
  --temporary-password "$TEMP_PASSWORD" \
  --region eu-central-1
```

Cognito invia email automatica con il temporary password. Al primo SRP sign-in, l'utente sarà forzato a cambiare la password.

#### F7.5.b.5 — Inserire la riga `users` per l'admin appena creato (SQL diretto)

Cognito gestisce **solo** authentication; il DB GarageOS è la source-of-truth per identity (tenant binding, role, profile). Il middleware `tenantContext` esegue `findFirstOrThrow({cognitoSub, tenantId})` su ogni richiesta autenticata: senza una riga `users` corrispondente al `Sub` Cognito appena emesso, ogni call con bearer token ritorna 404 al user lookup e l'auth gate è effettivamente bloccato.

Recuperare il `Sub` (UUID Cognito) dell'utente appena creato:

```bash
COGNITO_SUB=$(aws cognito-idp admin-get-user \
  --user-pool-id "$OFFICINE_POOL" \
  --username "$ADMIN_EMAIL" \
  --region eu-central-1 \
  --query "UserAttributes[?Name=='sub'].Value | [0]" \
  --output text)
echo "$COGNITO_SUB"   # UUID v4 — sanity check
```

Eseguire dal Supabase SQL Editor (sostituire i 3 placeholder con `$TENANT_ID` di F7.5.a, `$COGNITO_SUB` appena estratto e `$ADMIN_EMAIL`):

```sql
INSERT INTO users (
  tenant_id, cognito_sub, email, first_name, last_name, role, updated_at
) VALUES (
  '<TENANT_ID-da-F7.5.a>',
  '<COGNITO_SUB-da-comando-sopra>',
  'admin@example.com',
  'Admin',
  'Bootstrap',
  'super_admin',
  now()
)
RETURNING id;
```

Stessa logica di F7.5.a su `updated_at`: raw SQL bypassa il `@updatedAt` Prisma, quindi il valore va fornito (`now()`) per evitare la NOT NULL violation. `id`, `created_at`, `status`, `location_id` prendono i default dello schema (`gen_random_uuid()`, `now()`, `'active'`, `NULL`). I valori `first_name='Admin'` / `last_name='Bootstrap'` devono coincidere con i `Name=given_name` / `Name=family_name` di F7.5.b.

#### F7.5.c — Smoke test end-to-end auth

1. Dal client (curl, Postman, Amplify CLI) eseguire `USER_SRP_AUTH` con `$ADMIN_EMAIL` + `$TEMP_PASSWORD`.
2. Cognito risponde con challenge `NEW_PASSWORD_REQUIRED`. Risolvere con un nuovo password forte.
3. Ottenere `IdToken` dal response finale.
4. `curl -H "Authorization: Bearer $ID_TOKEN" https://api.garageos.it/v1/vehicles` — attendersi `200` con array vuoto, o `404`.
5. Se ricevuto `401`: probabile mismatch issuer/audience nel JWT verifier vs pool/client ID nel secret. Verificare con la Cognito console + il secret content (`aws secretsmanager get-secret-value --secret-id garageos/production/app`).

### F-Storage. Verifica S3 attachments bucket post-deploy

Dopo il primo deploy che ship-a la `StorageConstruct` (PR 23), valida i 5 punti seguenti dalla shell con AWS CLI configurato per l'account production. Il bucket name è esposto come CfnOutput `AttachmentsBucketName` (anche su SSM ricavabile da CloudFormation describe-stacks).

#### F-Storage.a — Bucket esiste

```bash
aws s3api head-bucket --bucket garageos-production-attachments
```

Expected: zero output, exit 0. Failure mode `404 NoSuchBucket` → CDK deploy non è atterrato. `403 Forbidden` → AWS principal manca permission (escalation IAM).

#### F-Storage.b — Encryption AES256

```bash
aws s3api get-bucket-encryption --bucket garageos-production-attachments
```

Expected JSON contiene `Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm = "AES256"`.

#### F-Storage.c — Versioning enabled

```bash
aws s3api get-bucket-versioning --bucket garageos-production-attachments
```

Expected `{"Status": "Enabled"}`. Non confondere con `MFADelete` (separato, non config-ato in v1).

#### F-Storage.d — CORS configurato

```bash
aws s3api get-bucket-cors --bucket garageos-production-attachments
```

Expected JSON con 1 rule: `AllowedMethods: ["GET", "PUT"]`, `AllowedOrigins: ["https://app.garageos.aifollyadvisor.com", "https://garageos.aifollyadvisor.com"]`, `AllowedHeaders: ["*"]`, `MaxAgeSeconds: 3000`.

Failure: se `CORSRule` array vuoto, il CDK deploy non ha applicato la CORS (cd `infrastructure/` && `cdk diff` per check).

#### F-Storage.e — Lifecycle rules

```bash
aws s3api get-bucket-lifecycle-configuration --bucket garageos-production-attachments
```

Expected JSON con 2 rule:

1. `Id: "transition-to-ia"`, `Transitions[0]: {Days: 90, StorageClass: "STANDARD_IA"}`, `NoncurrentVersionExpiration: {NoncurrentDays: 30}`.
2. `Id: "abort-incomplete-uploads"`, `AbortIncompleteMultipartUpload: {DaysAfterInitiation: 7}`.

#### Failure modes

- **`BucketAlreadyExists`** (deploy time): name `garageos-production-attachments` è globalmente reservato da altro account AWS. Workaround: rinominare in `productionConfig` e re-deploy. Probabilità bassissima (nome semantic specifico al progetto).
- **CORS preflight 403 da browser**: l'origine richiedente non matcha la lista. Verificare che la web app usi esattamente `https://app.garageos.aifollyadvisor.com` (no trailing slash, no `www.`).
- **Lifecycle non scatta visibile**: AWS applica le rule entro ~24h dal trigger event. Per test rapido, set un object con `aws s3api put-object` e check manuale dopo 24h.
- **Versioning impossibile da disabilitare**: una volta enabled, AWS permette solo Suspended (non Off). Decisione consapevole, mantenere Enabled.

### F-WAF. Verifica WAF Web ACL + association post-deploy

> **DEFERRED a PR 25 (2026-05-04)**: AWS WAFv2 REGIONAL scope **non supporta API Gateway HTTP API v2** — solo REST API v1, ALB, AppSync, Cognito user pool, App Runner, Verified Access. Il `WafConstruct` esiste in `lib/constructs/waf.ts` ma NON è istanziato dal `MainStack` post-fix di PR #51. PR 25 (web app + CloudFront + Cognito Hosted UI) lo istanzierà con `scope: 'CLOUDFRONT'` cross-region (us-east-1) attached al CloudFront distribution che fa edge in front di HTTP API v2. Per v1 pilota i protection layer attivi sono API Gateway throttling (200 burst / 100 rate, vedi `productionConfig.apiGateway`) + Lambda concurrency cap (100). I comandi sotto restano come riferimento per quando PR 25 ship-a il WAF.

Dopo il primo deploy che ship-a la `WafConstruct` (PR 25, deferred — vedi sopra), valida i 4 punti seguenti.

#### F-WAF.a — Web ACL esiste

```bash
aws wafv2 list-web-acls --scope REGIONAL --region eu-central-1
```

Expected JSON output contiene un WebACL con `Name: "garageos-production-api-waf"`. Capture il `Id` per il prossimo step.

#### F-WAF.b — Association al stage API Gateway

```bash
# Ricava lo stage ARN
API_ID=$(aws apigatewayv2 get-apis --region eu-central-1 \
  --query "Items[?Name=='garageos-api'].ApiId" --output text)
STAGE_ARN="arn:aws:apigateway:eu-central-1::/apis/${API_ID}/stages/\$default"

# Verifica association
aws wafv2 get-web-acl-for-resource --resource-arn "$STAGE_ARN" --region eu-central-1
```

Expected JSON ritorna `WebACL.Name: "garageos-production-api-waf"`. Failure `WAFNonexistentItemException` → association non applicata, controllare CFN events della stack.

#### F-WAF.c — CloudWatch metrics attive

```bash
aws cloudwatch list-metrics --namespace AWS/WAFV2 --region eu-central-1 \
  --query "Metrics[?Dimensions[?Value=='garageos-production-api-waf']].MetricName" --output text
```

Expected output contiene almeno: `AllowedRequests`, `BlockedRequests`, `CountedRequests` (le 3 metriche ACL-level pubblicate da WAFv2). Le metric per-rule (`AWSManagedRulesCommonRuleSet`, `AWSManagedRulesKnownBadInputsRuleSet`, `RateLimitIp`) compaiono **solo dopo che la rule è stata triggered almeno una volta**. Per smoke immediato, `AllowedRequests` basta.

#### F-WAF.d — Smoke negative test del rate limit (opzionale)

Per validare che il rate limit fa block, simula 3000+ req/5min da single IP a `/health` (rate limit 2000/5min):

```bash
# Da workstation operator
ab -n 3000 -c 100 https://api.garageos.aifollyadvisor.com/health
```

Expected: dopo ~2000 req il WAF inizia a rispondere con `403 Forbidden`. Se TUTTE le 3000 ritornano 200, controllare:

1. Association presente (F-WAF.b)
2. Rule priority 3 con action Block (`aws wafv2 get-web-acl --id <id> --scope REGIONAL --region eu-central-1`)

Smoke opzionale — il rate limit è eventually consistent (sliding window 5min), può richiedere 1-2 minuti di window perché si "saturi".

#### Failure modes

- **Association non visibile** post-deploy: stage ARN format errato. AWS richiede `arn:aws:apigateway:<region>::/apis/<apiId>/stages/<stageName>` con account section vuota e `$default` literal (non URL-encoded).
- **Falsi positivi CommonRuleSet** che bloccano traffico legittimo: workaround in CDK aggiungere `excludedRules` alla rule specifica nel `WafConstruct`. Ricognoscere via CloudWatch logs `AWS-WAF-Logs-<region>` (se enabled) o sampled requests in console.
- **Rate limit non kicks in**: il counter è eventually consistent (~30s-2min lag). Per test deterministico, aumentare burst velocemente o ridurre il limit temporaneamente.
- **CLOUDFRONT scope necessario in futuro**: PR 25 (web app + CloudFront) creerà un secondo WAF in us-east-1 — `WafConstruct` come scritto NON è cross-region, dovrà essere parametrizzato o duplicato.

### F8. Step 7 — Forza cold start della Lambda

Per far rileggere il secret aggiornato, invalidiamo i container Lambda warm aggiungendo una env var arbitraria:

```bash
aws lambda update-function-configuration \
  --function-name garageos-api \
  --region eu-central-1 \
  --environment 'Variables={NODE_ENV=production,APP_SECRETS_ARN=<incollare AppSecretsArn>,NODE_EXTRA_CA_CERTS=/var/task/supabase-ca.crt,SECRET_REVISION=1}'
```

Ad ogni populate-secret successivo, incrementare `SECRET_REVISION` per forzare un nuovo cold start.

### F9. Step 8 — Smoke test

```bash
# Via API Gateway endpoint AWS (utile mentre il DNS custom domain propaga)
curl -sf https://<HttpApiEndpoint>/health

# Via custom domain (post-DNS propagation, ~5-10 min dopo il deploy MainStack)
curl -sf https://api.garageos.it/health
```

Atteso: `200 OK` con body JSON tipo `{"status":"ok","version":"unknown",...}`.

### F10. Step 9 — Push trigger (attivo)

Dal merge della PR F10 push trigger, `.github/workflows/deploy.yml` triggera automaticamente su `push: branches: [main]` con path filter sui sorgenti che impattano l'artefatto deployato (`infrastructure/**`, `packages/{api,database,shared}/**`, `pnpm-lock.yaml`, il workflow stesso).

Su push trigger viene deployato `GarageosMainStack` (il fallback hardcoded nel job step), perché OidcStack è bootstrap-only. Per redeploy di OidcStack o `--all` si continua a usare `workflow_dispatch` manuale.

Il gate `environment: production` richiede approval manuale (required reviewer = Michele Matula, configurato in GitHub Settings → Environments). Senza approval il job rimane in `Waiting`.

**Prerequisiti già configurati in GitHub repo Settings (operator-driven, una tantum):**

- Secret `AWS_DEPLOY_ROLE_ARN` = `arn:aws:iam::<account-id>:role/garageos-github-deploy` (output di `OidcStack`).
- Environment `production` con required reviewer.

Senza questi due settings il primo run su `main` triggera ma fallisce su missing credentials.

### F11. Troubleshooting

| Sintomo | Causa probabile | Fix |
| --- | --- | --- |
| ACM cert in stato `PENDING_VALIDATION` per >30 min | NS records non propagati | Verificare che la hosted zone sia autoritativa: `dig NS garageos.it` deve mostrare i NS AWS |
| Lambda timeout 30s al primo invoke (`/health` → 504) | NodejsFunction bundling ha incluso male @garageos/database o native Prisma binaries | CloudWatch Logs Lambda → cercare errore esbuild / module not found. Eventuale fallback: aggiungere `@garageos/database` a `nodeModules` in lambda-api.ts e redeploy |
| CORS preflight fallisce dal frontend | Origin non in whitelist | Aggiungere l'origine a `corsPreflight.allowOrigins` in `infrastructure/lib/constructs/api-gateway.ts` e redeploy |
| `cdk deploy` errore "Hosted zone for garageos.it not found" | NS non propagati o account-id env mancante | Vedi step F5 — refresh contesto + attendere propagazione |
| Lambda cold start `AccessDeniedException secretsmanager:GetSecretValue` | grantRead non applicato sul ruolo execution | Verificare `infrastructure/lib/constructs/lambda-api.ts:executionRole` ha `props.appSecret.grantRead(executionRole)` |

### F12. Rollback

Vedere `docs/APPENDICE_C_INFRASTRUCTURE.md` §12 per le procedure complete (alias-based instant rollback, CDK redeploy, PITR Supabase, infra rollback).

In PR 21 — niente alias `live` ancora. Per un rollback rapido:

1. `git revert <commit-bad>` (in un nuovo branch + PR)
2. Merge il revert in `main`
3. Rilanciare workflow `Deploy infrastructure` → `GarageosMainStack`

Tempo totale: ~10-15 min (re-bundling Lambda + CloudFormation update).

## Comandi utili

```bash
# Synth (offline, mock mode — no AWS creds richieste)
CDK_SYNTH_MOCK=true pnpm --filter infrastructure synth

# Diff vs lo stack deployato
pnpm --filter infrastructure exec cdk diff GarageosMainStack

# Test assertion sul template
pnpm --filter infrastructure test
```

## TLS verification rotation runbook

The Lambda bundle ships the public Supabase root CA at
`/var/task/supabase-ca.crt` and the function's `NODE_EXTRA_CA_CERTS`
env var points to it. As long as `DATABASE_URL` / `DIRECT_URL` in
Secrets Manager use `sslmode=verify-full` (or fallback `verify-ca`),
the Postgres TLS handshake is properly chain-validated.

### When to run this runbook

- **First-time enablement** (post-merge of the TLS verification PR).
- **CA rotation** — when the vendored cert in `infrastructure/assets/supabase-ca.crt` is replaced because Supabase publishes a new root.
- **Suspected TLS misconfiguration** — recover from a transient `verify-ca`/`no-verify` fallback by re-attempting `verify-full`.

### Step 1 — Deploy CDK

The PR merges with the cert + env var already wired. Deploy:

```bash
pnpm --filter @garageos/infrastructure exec cdk deploy GarageosMainStack
```

Smoke: `curl https://api.garageos.aifollyadvisor.com/health` → 200, `database: ok`.

At this point the secret still has `sslmode=no-verify` (or whatever
mode was previously in place) — the Lambda is "armed but inert".

### Step 2 — Verify cert is in the Lambda zip

```bash
aws lambda get-function --function-name garageos-api \
  --query Code.Location --output text > /tmp/lambda-url.txt
curl -s -o /tmp/lambda.zip "$(cat /tmp/lambda-url.txt)"
unzip -l /tmp/lambda.zip | grep supabase-ca.crt
rm -f /tmp/lambda.zip /tmp/lambda-url.txt
```

Expected: 1 line listing `supabase-ca.crt`. If empty, the
`commandHooks.afterBundling` step did not run as expected — fix
before continuing.

### Step 3 — Rotate the secret to `sslmode=verify-full`

```bash
aws secretsmanager get-secret-value \
  --secret-id garageos/production/app \
  --query SecretString --output text > /tmp/secret.json

# Edit /tmp/secret.json: replace sslmode=no-verify with sslmode=verify-full
# in both DATABASE_URL and DIRECT_URL values. Use jq or sed.

aws secretsmanager update-secret \
  --secret-id garageos/production/app \
  --secret-string file:///tmp/secret.json

shred -u /tmp/secret.json
```

### Step 4 — Force Lambda cold start

`update-secret` does NOT recycle warm containers. They have the old
`DATABASE_URL` already loaded in memory. To invalidate them, bump a
dummy env var. **Read the current env vars first** — the
`update-function-configuration --environment` flag REPLACES the full
set, never merges.

```bash
CURRENT=$(aws lambda get-function-configuration \
  --function-name garageos-api \
  --query Environment.Variables --output json)
NEW=$(echo "$CURRENT" | jq '. + {SECRET_REVISION: "2"}')
aws lambda update-function-configuration \
  --function-name garageos-api \
  --environment "Variables=$NEW"
```

Bump `SECRET_REVISION` (`"2"` → `"3"` …) on each subsequent rotation.

Hands-off alternative: wait ~15-30 min of idle traffic; AWS recycles
warm containers naturally.

### Step 5 — Smoke-test post-rotate

```bash
curl https://api.garageos.aifollyadvisor.com/health
# Expect 200 with database: ok

# With a valid bearer token:
curl -H "Authorization: Bearer $TOKEN" \
  https://api.garageos.aifollyadvisor.com/v1/users/me
# Expect 200 with full user JSON
```

Inspect CloudWatch logs `/aws/lambda/garageos-api` for the latest
cold-start invocations: no entries containing `self-signed certificate`,
`unable to verify`, or `Hostname/IP does not match`.

### Failure modes and fallbacks

- **`Hostname/IP does not match certificate's altnames`**
  The pooler hostname is not in the cert SAN. Repeat Step 3 with
  `sslmode=verify-ca` (validates chain, skips hostname check). This
  is still much better than `no-verify` — the cert chain proves the
  server controls the matching private key.
- **`unable to verify the first certificate` / `self-signed certificate in certificate chain`**
  The cert in `infrastructure/assets/supabase-ca.crt` is wrong,
  outdated, or the bundle is missing it. Re-download from the
  Supabase dashboard (see `SUPABASE_CA_NOTES.md`), replace, redeploy.
- **`certificate has expired`**
  `notAfter` reached. Same fix: download successor CA from Supabase,
  replace, redeploy. Update `SUPABASE_CA_NOTES.md` with new dates.
- **Last-resort rollback**
  Repeat Step 3 with `sslmode=no-verify`. This restores connectivity
  while you debug. Open a tech-debt ticket immediately — `no-verify`
  is **not** an acceptable steady state.

## Runtime DB role rotation runbook

The runtime Lambda originally connected as the `postgres` superuser; this
runbook switches it to the least-privilege role `garageos_app` introduced by
migration `20260430120000_create_garageos_app_role`. The migration creates the
role NOLOGIN with a placeholder password — the operator must set the real
password and rotate the secret before the role becomes effective. DIRECT_URL
(used by `prisma migrate deploy` from the operator's machine) stays on the
`postgres` superuser.

### When to run this runbook

- **First-time enablement** (post-merge of this PR).
- **Password rotation** of `garageos_app`: re-run Step 2 with a new password,
  then Steps 3 → 5. Step 1 is a no-op once the role exists (migration is
  idempotent).
- **Re-bootstrap** in a fresh environment (staging, demo): full sequence
  Steps 1 → 5.

### Step 1 — Apply the migration

From local machine, with `DIRECT_URL` set to the `postgres` superuser
connection string in `packages/database/prisma/.env` or via `DIRECT_URL` env:

```bash
pnpm --filter @garageos/database prisma:migrate:deploy
```

Expected: `Applying migration 20260430120000_create_garageos_app_role`. Effect:
role created `NOLOGIN` with placeholder password; grants and default
privileges applied. Safe — `NOLOGIN` blocks any auth attempt with the
placeholder until Step 2 flips it.

### Step 2 — Set the real password

Generate a strong password (32 random bytes, base64). Never commit, never log,
never paste into chat:

```bash
openssl rand -base64 32
# (copy the output to clipboard; do NOT echo it back to the terminal scrollback)
```

Open Supabase SQL Editor as `postgres` and run (paste the generated password):

```sql
ALTER ROLE garageos_app LOGIN PASSWORD '<paste-generated-password>';
```

Expected: `ALTER ROLE`. The role is now able to authenticate.

### Step 3 — Pre-validation smoke (gate before secret rotation)

In the Supabase SQL Editor, run the validation matrix below. This catches
missing grants or REVOKEs **before** the production Lambda starts using the
new role.

**3.a — Positive (CRUD works under app context)**

In a SQL Editor session, run:

```sql
SET SESSION AUTHORIZATION garageos_app;

-- Wire app context to the bootstrap tenant
SELECT set_app_context(
  'd43caa62-3406-4bf7-97eb-2da0a5b356e5'::uuid,  -- bootstrap tenant id
  NULL,
  'admin'
);

-- Tenant-isolated tables: should return rows now
SELECT id FROM vehicles  LIMIT 1;
SELECT id FROM customers LIMIT 1;

-- Permissive-SELECT tables: should return rows even without context (sanity)
SELECT id FROM tenants LIMIT 1;
SELECT id FROM users   LIMIT 5;

-- Append: must succeed
INSERT INTO access_logs (
  id, user_id, tenant_id, action, resource_type, resource_id, ip_address
) VALUES (
  gen_random_uuid(),
  (SELECT id FROM users WHERE tenant_id = 'd43caa62-3406-4bf7-97eb-2da0a5b356e5' LIMIT 1),
  'd43caa62-3406-4bf7-97eb-2da0a5b356e5',
  'view',
  'vehicle',
  gen_random_uuid(),
  '127.0.0.1'
);
```

Expected: tutti i SELECT ritornano almeno 1 riga; l'INSERT ritorna `INSERT 0 1`.

**3.b — Negative (REVOKE on append-only audit tables)**

Same session, run:

```sql
-- Must fail: ERROR 42501 permission denied for table access_logs
UPDATE access_logs SET ip_address = '0.0.0.0' WHERE id = (SELECT id FROM access_logs LIMIT 1);

-- Must fail: ERROR 42501 permission denied for table audit_logs
DELETE FROM audit_logs WHERE id = (SELECT id FROM audit_logs LIMIT 1);

-- Must fail: ERROR 42501 permission denied for table intervention_revisions
UPDATE intervention_revisions SET created_at = NOW() WHERE id = (SELECT id FROM intervention_revisions LIMIT 1);
```

Expected: all three fail with `permission denied` (SQLSTATE `42501`).

**3.c — Negative (RLS tenant isolation still enforced without app context)**

In a **fresh tab of the SQL Editor** (new session, no prior `set_app_context`):

```sql
SET SESSION AUTHORIZATION garageos_app;

-- vehicles and customers remain tenant-isolated on SELECT post-split
SELECT * FROM vehicles  LIMIT 5;  -- expected: 0 rows
SELECT * FROM customers LIMIT 5;  -- expected: 0 rows
```

Expected: 0 rows from both.

**Gate decision:**

| Result | Action |
|--------|--------|
| All green | Proceed to Step 4 |
| Any test red | DO NOT proceed. Diagnose: missing GRANT? Extra REVOKE? Apply fix in SQL Editor, re-run 3.a/3.b/3.c. Only after green → Step 4. |

### Step 4 — Rotate the production secret

```bash
# 1. Pull current secret value
aws secretsmanager get-secret-value \
  --secret-id garageos/production/app \
  --region eu-central-1 \
  --query SecretString --output text > /tmp/secret.json

# 2. Edit /tmp/secret.json:
#    DATABASE_URL: change the username component from `postgres` to
#                  `garageos_app`, and replace the password with the value
#                  generated in Step 2. Keep host, port, database name, and
#                  all query parameters (sslmode=verify-full, etc.) unchanged.
#    DIRECT_URL: leave unchanged (postgres superuser, used only for migrations).

# 3. Push the new value
aws secretsmanager update-secret \
  --secret-id garageos/production/app \
  --region eu-central-1 \
  --secret-string file:///tmp/secret.json

# 4. Cleanup local file
shred -u /tmp/secret.json   # or `rm -P` on macOS, secure-delete equivalent on Windows
```

Force a Lambda cold start so the new secret is read. Recommended path: bump
`SECRET_REVISION` constant in `infrastructure/lib/lambda-api.ts` and run
`cdk deploy MainStack`. CDK preserves all other env vars. Alternative manual
path via AWS CLI requires passing the entire env block (the
`update-function-configuration` command **replaces** env, not merges).

### Step 5 — Smoke prod

```bash
curl -sf https://api.garageos.aifollyadvisor.com/health
# Expected: {"status":"ok","database":"ok",...}
```

Tail CloudWatch logs first 5 minutes:

```bash
aws logs tail /aws/lambda/garageos-api \
  --since 5m \
  --region eu-central-1 \
  --follow \
  | grep -iE 'permission denied|42501|password authentication failed|fatal'
```

Expected: no matches. If `permission denied` or `42501` appears: missing GRANT
(go back to Step 3, identify which table/function, add GRANT in SQL Editor,
re-validate). If `password authentication failed` appears: secret value wrong
(go back to Step 4, check the DATABASE_URL).

### Failure modes and fallbacks

- **`permission denied for table X`** (SQLSTATE 42501)
  Missing GRANT on table `X` for `garageos_app`. Probable cause: table
  added by a more recent migration that didn't include explicit GRANT
  (and DEFAULT PRIVILEGES doesn't apply to pre-existing objects).
  Immediate fix: `GRANT SELECT, INSERT, UPDATE, DELETE ON X TO garageos_app;`
  in SQL Editor. Open follow-up: add GRANT to the original migration of
  `X` (retroactively) or create a patch migration.

- **`permission denied for function Y`** (SQLSTATE 42501)
  Same pattern, function side: `GRANT EXECUTE ON FUNCTION Y(...) TO garageos_app;`.

- **`password authentication failed for user "garageos_app"`**
  Secret has wrong password OR Step 2 flipped the wrong role. Verify the
  DATABASE_URL stored in Secrets Manager has `garageos_app` as username and
  that the password matches the one set in Step 2. Rotate again if needed.

- **Last-resort rollback**
  Revert `DATABASE_URL` in the secret to the prior `postgres` value, push
  via `update-secret`, force cold start. RTO ~2 min. The migration stays in
  the repo (idempotent — re-applying does nothing destructive). To remove
  the role entirely: `DROP ROLE garageos_app` from SQL Editor as `postgres`
  after the secret has been reverted.

### Future-proofing: when adding a new audit/append-only table

The `ALTER DEFAULT PRIVILEGES` clauses in the migration auto-grant blanket
CRUD on any new table created by `postgres` later. For an append-only table
(audit log style), the migration that introduces it MUST include:

```sql
-- After CREATE TABLE foo_log (...);
REVOKE UPDATE, DELETE ON foo_log FROM garageos_app;
```

This mirrors the pattern used in this migration for `access_logs`, `audit_logs`,
`intervention_revisions`. Tracked as tech debt: see
`project_tech_debt.md` → "Future audit/append-only tables need manual REVOKE".

## F-INF-WEB — Web hosting deployment (PR demo-0+)

Web app statica per `https://app.garageos.aifollyadvisor.com`. Stack: S3 privato + CloudFront (Origin Access Control) + Route 53 alias + ACM cert in us-east-1. Diviso su due stack CDK: `GarageosWebStack` (eu-central-1) e `GarageosWebCertStack` (us-east-1).

### Prerequisite: bootstrap us-east-1 (one-time)

CDK richiede un bootstrap dedicato per ciascuna region in cui deploya. Prima del primo deploy della WebCertStack:

```bash
pnpm --filter infrastructure exec cdk bootstrap aws://${ACCOUNT_ID}/us-east-1
```

Verificare che esista il bootstrap stack `CDKToolkit` in us-east-1 nella console CloudFormation. eu-central-1 era già bootstrappato (PR #29).

### First deploy (manuale, post-merge)

Il push a `main` triggera `deploy.yml` che esegue `cdk deploy GarageosMainStack GarageosWebCertStack GarageosWebStack`. CDK risolve la dependency order automaticamente via `crossRegionReferences: true`. Tempo atteso: 10-20 minuti (la prima creazione di CloudFront propaga ~15 min globalmente).

Eventuali fallimenti tipici:
- **`Bucket name already exists`**: `garageos-production-web` non globalmente unico. Mitigation: cambiare `webBucketName` in `lib/config/production.ts` aggiungendo un suffix account-id.
- **`Unable to create record set ... already exists`**: record A/AAAA su `app.<domain>` già presenti in Route 53 (creati a mano). Mitigation: rimuoverli da console pre-deploy (`aws route53 list-resource-record-sets --hosted-zone-id <id>` per ispezione).
- **`Certificate validation timed out`**: NS del dominio non puntano alla hosted zone Route 53. Verificare con `dig +short NS garageos.aifollyadvisor.com`.

### Smoke post-deploy

```bash
# 1. HTTPS root → 200 + HTML placeholder
curl -I https://app.garageos.aifollyadvisor.com/

# 2. SPA fallback → 200 + index.html body (la rotta non esiste ma la SPA error response copre)
curl https://app.garageos.aifollyadvisor.com/random/path | grep -q '<h1>GarageOS' && echo OK

# 3. HTTP redirect → 301 https
curl -I http://app.garageos.aifollyadvisor.com/

# 4. DNS resolve a CloudFront edge
dig +short app.garageos.aifollyadvisor.com
```

Se i curl sopra falliscono entro i primi 15 minuti, attendere la propagazione CloudFront e riprovare. Per debug usare il `CloudFrontDomainName` CfnOutput (es. `d1234abcdef.cloudfront.net`) per bypassare il DNS custom.

### Asset deploy (placeholder e successivi)

Modifiche a `infrastructure/assets/web-placeholder/**` triggerano `deploy-web.yml`, che fa `aws s3 sync` + `cloudfront create-invalidation /*`. In PR demo-1+ il workflow sarà esteso per buildare `packages/web/` e syncare la `dist/`.

### Rollback

- **Frontend asset**: `aws s3 cp` di una copia precedente del bundle + invalidation. (Versioning sul bucket è disabilitato: il rollback si fa via re-deploy dal commit precedente sull'asset.)
- **Stack CDK**: `aws cloudformation cancel-update-stack --stack-name GarageosWebStack` durante un deploy in corso, oppure deploy del commit precedente. `removalPolicy: RETAIN` sul bucket protegge i dati.

## F-WEB-VARS — GitHub Actions Variables for the web build

The `deploy-web.yml` workflow reads four `vars.VITE_*` to inject Cognito and
API config into the Vite bundle at build time. These are public (extractable
from the bundle) — store them as repository **Variables** (not Secrets).

### Required variables

| Variable | Source |
|---|---|
| `VITE_COGNITO_OFFICINE_POOL_ID` | CloudFormation output `CognitoOfficineUserPoolId` of `GarageosMainStack` |
| `VITE_COGNITO_OFFICINE_CLIENT_ID` | CloudFormation output `CognitoOfficineClientId` of `GarageosMainStack` |
| `VITE_COGNITO_REGION` | `eu-central-1` |
| `VITE_API_BASE_URL` | `https://api.garageos.aifollyadvisor.com` |

### Resolve the Cognito IDs

```bash
aws cloudformation describe-stacks --stack-name GarageosMainStack \
  --query "Stacks[0].Outputs[?OutputKey=='CognitoOfficineUserPoolId' || OutputKey=='CognitoOfficineClientId']" \
  --output table
```

### Set the variables (one-time, ~5 min)

Repository Settings → Variables → Actions → New repository variable, four times.
Or via `gh`:

```bash
gh variable set VITE_COGNITO_OFFICINE_POOL_ID    --body 'eu-central-1_xxxxx'
gh variable set VITE_COGNITO_OFFICINE_CLIENT_ID  --body 'xxxxxxxxxxxxxxxxxxxxxxxxxx'
gh variable set VITE_COGNITO_REGION              --body 'eu-central-1'
gh variable set VITE_API_BASE_URL                --body 'https://api.garageos.aifollyadvisor.com'
```

Verify:

```bash
gh variable list
```

### DR fallback

If the build pipeline is broken and the operator needs to roll back the web
asset urgently, sync the legacy placeholder directly:

```bash
aws s3 sync infrastructure/assets/web-placeholder/ \
  s3://<bucket>/ --delete
aws cloudfront create-invalidation --distribution-id <dist> --paths '/*'
```

The placeholder is kept in the repo for exactly this scenario.

## F-WEB-DEMO2 — Smoke checklist post-deploy demo-2

After GitHub Actions `deploy-web.yml` succeeds on the demo-2 PR squash:

1. `curl -I https://app.garageos.aifollyadvisor.com/` → 200, `content-type: text/html`
2. Open URL in browser → automatic redirect `/login` (no `/dashboard` placeholder)
3. Sign in with `matulamichele@gmail.com` / production password → redirect `/`
4. Dashboard renders: Sidebar (slate-900, "Cerca veicolo" active) + TopBar (email + dropdown) + SearchHero (h1 "Cerca un veicolo")
5. Type `AB123CD` → live hint "→ ricerca per targa" appears below input
6. Click "Cerca →" → URL becomes `/search?q=AB123CD&t=plate`
7. SearchResults page shows empty state ("Nessun veicolo trovato") — expected, prod DB has no demo vehicles
8. Manual nav: paste `/vehicles/00000000-0000-0000-0000-000000000000` → toast "Veicolo non trovato" + redirect `/`
9. Click TopBar dropdown → "Esci" → redirect `/login`, browser localStorage `CognitoIdentityServiceProvider.*` cleared
10. Refresh `/` while unauthenticated → redirect `/login`

All 10 PASS = demo-2 LIVE.

## F-PILOT-DEMO — Pilot demo seed (production)

Popola il DB di produzione con dati realistici per la demo Persona A "Giuseppe": 1 officina + 3 customers + 5 vehicles + 20 interventi storici (BR-068 km monotonici per veicolo). Lo script è idempotente — re-run sicuro.

### Prerequisiti

- F-7.5 completato per l'officina pilota (Cognito user `super_admin` Giuseppe creato + riga `users` seedata via il flusso bootstrap manuale).
- Variabile `PILOT_DEMO_SUB` = `sub` Cognito di Giuseppe (visibile in Cognito console o via `aws cognito-idp admin-get-user`).
- `DATABASE_URL` = Supabase pooler URL produzione (lo stesso usato dall'API). Il caller può estrarlo da Secrets Manager (`garageos-app/api/database`) e tenerlo solo nello shell, mai committato.
- **(opzionale)** `PILOT_DEMO_EMAIL_BASE` = casella reale recapitabile (es. `tuonome@gmail.com`). Se impostata, ogni persona diventa un **plus-alias Gmail** (`tuonome+giuseppe@gmail.com`, `tuonome+mario@gmail.com`, …) così tutte le notifiche arrivano in quell'unica inbox. Se non impostata, le email restano sul dominio non-recapitabile `demo-giuseppe.test` (default committato, nessuna PII nel repo pubblico). Tag personas: `officina`, `giuseppe`, `mario`, `luigi`, `anna`.

### Run

```bash
# DATABASE_URL = pooler URI estratto da Secrets Manager (garageos/production/app, key DATABASE_URL).
# Mantieni il valore solo nello shell session — non committarlo né stamparlo in scrollback.
export DATABASE_URL="<supabase_pooler_uri>"
export PILOT_DEMO_SUB="<sub_giuseppe>"
# Opzionale: instrada le email demo verso una inbox reale via plus-alias.
export PILOT_DEMO_EMAIL_BASE="tuonome@gmail.com"

pnpm --filter @garageos/database seed:pilot-demo
```

Output atteso:

```
[pilot-demo seed] OK — tenant Officina Giuseppe Bianchi (IT00000000000), 3 customers, 5 vehicles, 20 interventions
```

### Note

- Il seed esegue write su `tenants`/`users`/`interventions` che hanno RLS attiva. Le policy RLS richiedono `set_app_context()` (chiamata dall'API server) per autorizzare le write tenant-scoped — il seed gira fuori dal server applicativo e quindi quel context è assente, perciò il role applicativo `garageos_app` (NOBYPASSRLS) non riesce a scrivere. **Per il primo run, usare il `DIRECT_URL` superuser** estratto dallo stesso secret `garageos/production/app` (key `DIRECT_URL`): `postgres` ha BYPASSRLS automatico e il seed completa senza configurazione di context.
- Re-run su DB già popolato è no-op per le righe esistenti (tenant by `vat_number`, customer by `email`, vehicle by `vin`, intervention triple) e non cancella dati live creati durante la demo. **Eccezione:** i customer sono keyed by `email` — cambiare `PILOT_DEMO_EMAIL_BASE` tra due run crea nuove righe customer (le vecchie restano). Per un demo pulito, semina con la base email definitiva fin dal primo run o ripulisci i customer demo prima del re-run.
- **Email in sandbox SES**: finché l'account SES è in sandbox (`ProductionAccessEnabled: false`), ogni indirizzo `PILOT_DEMO_EMAIL_BASE` + alias va **verificato singolarmente** prima che le mail vengano recapitate: `aws sesv2 create-email-identity --email-identity "tuonome+giuseppe@gmail.com" --region eu-central-1` (poi clicca il link nella inbox). Verifica lo stato con `aws sesv2 list-email-identities --region eu-central-1` (`VerificationStatus: SUCCESS`).

## F-WEB-DEMO3 — Smoke checklist post-deploy demo-3 (form crea intervento)

After F-PILOT-DEMO eseguito, validazione manuale end-to-end. Tempo stimato ~10 minuti.

1. Open `https://app.garageos.aifollyadvisor.com/`, login con credenziali Giuseppe → Dashboard renders.
2. Type `Fiat` → Enter (or click `Cerca →`) → SearchResults card "Fiat Panda" `AB123CD`.
3. Click card → VehicleDetail mostra dati tecnici (Fiat Panda 1.2 8V, anno 2018), customer mascherato (Mario R.), badge stato `Certificato`. Annota dalla timeline il km dell'intervento più recente (`MAX`).
4. Click CTA `Registra intervento` (header) → atterra `/vehicles/<id>/interventions/new`. Form mostra 4 campi obbligatori a vista; sezioni opzionali collassate.
5. Happy path: data oggi, tipo `Tagliando`, km = `MAX + 5000`, descrizione "Tagliando smoke demo-3" → `Salva` → toast verde "Intervento registrato", redirect scheda, nuovo intervento in cima alla timeline.
6. 409 path: torna su CTA, data oggi, tipo `Cambio olio`, **km = `MAX - 10000`** (sotto al massimo storico ora aggiornato a `MAX + 5000`), descrizione "Smoke 409" → `Salva` → modal "Km inferiori allo storico" con messaggio backend e 2 CTA `Correggi` / `Conferma e salva`.
7. Click `Conferma e salva` → modal chiude, toast verde, redirect, nuovo intervento in timeline (con `kmAnomaly=true` server-side, visibile via API ma non strettamente necessario in UI).
8. TopBar dropdown → `Esci` → redirect `/login`. Reload `/vehicles/<id>` → redirect `/login` (protected route).

All 8 PASS = demo-3 LIVE definitivo. Aggiornare `project_resume_checkpoint.md` con esito.

## F13 — SES verify-email post-deploy runbook (G1)

After `cdk deploy MainStack` ships the SES construct, follow these steps to enable the verify-email flow end-to-end.

### F13.0 — Apply the DB migration to Supabase production (PREREQUISITE)

⚠️ **Required before any signup / verify-email curl.** The `cdk deploy` workflow ships the Lambda + SES infra but does NOT apply Prisma migrations to the production database. Without this step, all 3 routes (`/v1/auth/signup`, `/v1/auth/verify-email`, `/v1/auth/resend-verification`) return 500 with `relation "public.email_verifications" does not exist`.

```bash
# From operator workstation, with DATABASE_URL_DIRECT pointing to Supabase prod:
pnpm --filter @garageos/database db:migrate:deploy
# Expect: "X migrations applied" — the new migration `20260507120000_add_email_verifications`
```

Verify post-apply:
```bash
psql "$DATABASE_URL_DIRECT" -c "\dt public.email_verifications"
psql "$DATABASE_URL_DIRECT" -c "SELECT COUNT(*) FROM customers WHERE email_verified IS NOT NULL;"
# Expect: column exists, all existing rows backfilled to email_verified=true
```

This step applies to all future PRs that ship migrations — it's an existing operator-driven gap (no CI auto-apply) that this section now documents explicitly.

### F13.1 — Verify the domain identity in SES

1. AWS Console → SES (eu-central-1) → Verified identities.
2. Locate `garageos.aifollyadvisor.com`. Status should transition to **Verified** within 5-15 minutes (DKIM CNAMEs propagate via Route 53). If still pending after 30 min, check Route 53 → `garageos.aifollyadvisor.com` hosted zone → confirm the 3 `*._domainkey.garageos.aifollyadvisor.com` CNAME records exist.

### F13.2 — Sandbox vs production access

SES accounts start in **sandbox mode** (send only to verified recipient addresses). To exit sandbox:

1. AWS Console → SES → Account dashboard → "Request production access".
2. Use case: `Transactional` (NOT marketing).
3. Mail type: Transactional.
4. Volume: 100 emails/day v1, < 10/day average.
5. Compliance: confirm we don't send unsolicited / marketing email.
6. Wait 1-3 business days for AWS approval.

While waiting, manually verify recipient email addresses you need for smoke (SES Console → Verified identities → "Create identity" → Email).

### F13.3 — Smoke gate — full E2E

Once domain identity is verified and at least one recipient email is sandbox-approved (or prod access granted):

```bash
# 1. Trigger signup with a verified-recipient email
curl -X POST https://api.garageos.aifollyadvisor.com/v1/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"type":"customer","email":"matulamichele+verify1@gmail.com","password":"Password1","firstName":"Test","lastName":"User"}'
# Expect 201

# 2. Email arrives in inbox within ~30s
# 3. Click the link in the email → opens https://app.garageos.aifollyadvisor.com/verify-email?token=...
# 4. Page shows "Email verificata" within ~1s
# 5. Verify in DB:
psql "$DATABASE_URL" -c \
  "SELECT email, email_verified FROM customers WHERE email='matulamichele+verify1@gmail.com';"
# Expect email_verified=t
psql "$DATABASE_URL" -c \
  "SELECT consumed_at FROM email_verifications WHERE customer_id=(SELECT id FROM customers WHERE email='matulamichele+verify1@gmail.com');"
# Expect consumed_at NOT NULL
```

### F13.4 — Resend smoke

```bash
curl -X POST https://api.garageos.aifollyadvisor.com/v1/auth/resend-verification \
  -H 'Content-Type: application/json' \
  -d '{"email":"matulamichele+verify1@gmail.com"}'
# Expect 200 { "sent": true }

# Anti-enum check: same response for unknown email
curl -X POST https://api.garageos.aifollyadvisor.com/v1/auth/resend-verification \
  -H 'Content-Type: application/json' \
  -d '{"email":"definitely-does-not-exist@example.com"}'
# Expect 200 { "sent": true }
```

### F13.5 — Bounce / complaint handling

NOT wired in v1. Volume is too low to justify SNS bounce-notification topic + handler Lambda. Add when:

- Daily volume > 100 emails/day, OR
- SES reputation dashboard shows > 1% bounce rate.

Tracked in `project_tech_debt.md`.

## F14 — Scheduler smoke runbook (post-deploy verification)

Run these checks after the PR auto-deploy ships SchedulerConstruct (cluster G2).
All checks are read-only — they do not mutate state.

### F14.1 Verify WarmingSchedule active

```bash
aws scheduler get-schedule \
  --name garageos-api-warming \
  --group-name default \
  --region eu-central-1 \
  --query "{State:State, Expression:ScheduleExpression, Tz:ScheduleExpressionTimezone}"
```

Expected: `State=ENABLED`, `Expression=cron(*/5 8-20 ? * MON-SAT *)`, `Tz=Europe/Rome`.

### F14.2 Verify DeadlineGroup created (empty at deploy time)

```bash
aws scheduler get-schedule-group \
  --name garageos-deadlines \
  --region eu-central-1 \
  --query "{State:State, Arn:Arn}"
```

Expected: `State=ACTIVE`. The group will remain empty until H notifications PR ships and the app starts creating runtime schedules.

### F14.3 Smoke warming hits Lambda

After waiting ≥5 min during business hours (Mon–Sat 08:00–20:00 Europe/Rome):

```bash
aws logs tail /aws/lambda/garageos-api \
  --since 10m \
  --region eu-central-1 \
  --filter-pattern '{ $.source = "warming" }'
```

Expected: ≥1 line per 5-min business-hour window with shape `{"source":"warming","ts":"<ISO timestamp>"}`. If none appear, check F14.1 state and confirm current time falls inside the cron window.

> **PowerShell note**: the filter pattern uses CloudWatch JSON event syntax (`{ $.source = "warming" }`) — this works cross-shell. The token-style pattern `'"source":"warming"'` is rejected by CloudWatch's parser (`:` is not allowed in unquoted terms) when invoked from PowerShell.

### F14.4 Verify Lambda env vars populated

```bash
aws lambda get-function-configuration \
  --function-name garageos-api \
  --region eu-central-1 \
  --query "Environment.Variables.{Group:SCHEDULER_GROUP_NAME, RoleArn:SCHEDULER_ROLE_ARN}"
```

Expected: both populated, no placeholder. `Group` should be `garageos-deadlines`, `RoleArn` should be a valid ARN.

If any check fails, do NOT proceed with H notifications PR. Investigate via CloudFormation events on `MainStack` and the SchedulerConstruct logical IDs.

## F15 — Monitoring smoke runbook (post-deploy verification)

Run these checks after the PR auto-deploy ships MonitoringConstruct (cluster G3).
All checks are read-only except F15.1 (creates an SNS subscription) and F15.3 (toggles alarm state).

### F15.1 Subscribe operator email to AlertTopic

```bash
aws sns subscribe \
  --topic-arn $(aws cloudformation describe-stacks \
                --stack-name GarageosMainStack --region eu-central-1 \
                --query 'Stacks[0].Outputs[?OutputKey==`MonitoringAlertTopicArn`].OutputValue' \
                --output text) \
  --protocol email \
  --notification-endpoint matulamichele@gmail.com \
  --region eu-central-1
```

Expected: SubscriptionArn returned (initially `pending confirmation`). Operator confirms by clicking the link in the AWS confirmation email (token expiry: 3 days). If the email lands in spam, whitelist `no-reply@sns.amazonaws.com`.

### F15.2 Verify CloudWatch alarms created

```bash
aws cloudwatch describe-alarms \
  --region eu-central-1 \
  --alarm-name-prefix garageos-api- \
  --query 'MetricAlarms[].{Name:AlarmName, State:StateValue}'
```

Expected: 4 alarms in state `INSUFFICIENT_DATA` (or `OK` once metrics start flowing):
- `garageos-api-lambda-errors`
- `garageos-api-lambda-duration`
- `garageos-api-lambda-throttles`
- `garageos-api-apigw-5xx`

### F15.3 Test alarm path end-to-end

Force one alarm to ALARM state to validate email delivery:

```bash
# Force ALARM
aws cloudwatch set-alarm-state --region eu-central-1 \
  --alarm-name garageos-api-lambda-throttles \
  --state-value ALARM \
  --state-reason "F15.3 smoke test"

# Email "ALARM: garageos-api-lambda-throttles in EU (Frankfurt)" expected within 2 minutes
# Reset OK
aws cloudwatch set-alarm-state --region eu-central-1 \
  --alarm-name garageos-api-lambda-throttles \
  --state-value OK \
  --state-reason "F15.3 smoke complete"
```

Expected: email arrives at the subscribed address within ~2 minutes. Reset puts the alarm back to `OK` so the dashboard does not show stale ALARM state.

### F15.4 Verify Dashboard

URL (also exposed via CfnOutput `MonitoringDashboardUrl`):

```
https://eu-central-1.console.aws.amazon.com/cloudwatch/home?region=eu-central-1#dashboards:name=GarageOS-Production
```

Open in browser, verify 4 widgets visible:
- API Requests (Invocations)
- Lambda Duration (p50/p95/p99 series)
- API Gateway Errors (4xx/5xx)
- Lambda Concurrency & Throttles

If widgets show "No data" at first access (Lambda zero-traffic in the prior 15 min), generate traffic with:

```bash
curl https://api.garageos.aifollyadvisor.com/health
```

Wait 1-2 min (CW metrics 1-min ingestion delay) and refresh.

### F15.5 Cold-start observability via X-Ray (no widget, query ad-hoc)

X-Ray Tracing is `ACTIVE` on Lambda + APIGW (since PR #29). Service map shows p99 of `Initialization` segment.

For derived cold-start% via CloudWatch Logs Insights (saved query "GarageOS Cold Start %"):

```
filter @type = "REPORT"
| stats count(*) as invocations,
        count(@initDuration) as coldStarts,
        (count(@initDuration) * 100 / count(*)) as coldStartPct by bin(5m)
```

Expected at pilot scale: <5% cold-start% with WarmingSchedule active (PR #70 G2). If ≥10% sustained, investigate Lambda init time regression or warming schedule failure.

If any check fails, investigate via CloudFormation events on `MainStack` and the MonitoringConstruct logical IDs.
