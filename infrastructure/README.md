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
pnpm --filter infrastructure cdk bootstrap aws://ACCOUNT_ID/eu-central-1
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
pnpm --filter infrastructure cdk deploy GarageosOidcStack
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
pnpm --filter infrastructure cdk synth GarageosMainStack
```

Se c'è un errore "Hosted zone for garageos.it not found", attendere qualche minuto e ripetere.

### F6. Step 5 — Primo deploy MainStack (con secret placeholder)

```bash
pnpm --filter infrastructure cdk deploy GarageosMainStack
```

Tempo atteso: **10-15 minuti** (la voce più lenta è la validazione DNS del certificato ACM, 5-10 min). Mantenere il terminale aperto.

Output di interesse:

```
GarageosMainStack.ApiUrl = https://api.garageos.it
GarageosMainStack.HttpApiEndpoint = https://abc123.execute-api.eu-central-1.amazonaws.com
GarageosMainStack.LambdaFunctionArn = arn:aws:lambda:eu-central-1:...
GarageosMainStack.AppSecretsArn = arn:aws:secretsmanager:eu-central-1:...:secret:garageos/production/app-XXXXX
```

A questo punto la Lambda esiste, ma ogni request fallisce: il secret è popolato con `REPLACE_AFTER_DEPLOY` per i 7 campi.

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
aws secretsmanager update-secret \
  --secret-id garageos/production/app \
  --region eu-central-1 \
  --secret-string '{
    "DATABASE_URL": "<incollare DATABASE_URL Supabase>",
    "DIRECT_URL": "<incollare DATABASE_URL_DIRECT Supabase>",
    "COGNITO_OFFICINE_POOL_ID": "<CognitoOfficineUserPoolId>",
    "COGNITO_OFFICINE_CLIENT_ID": "<CognitoOfficineClientId>",
    "COGNITO_CLIENTI_POOL_ID": "<CognitoClientiUserPoolId>",
    "COGNITO_CLIENTI_CLIENT_ID": "<CognitoClientiClientId>",
    "SENTRY_DSN": "https://placeholder@sentry.io/0"
  }'
```

> Pre-PR-22 fallback: usare placeholder `eu-central-1_PLACEHOLDER` / `PLACEHOLDER` per i 4 ID Cognito. Soddisfano il regex di `env.ts` ma puntano a pool inesistenti — la Lambda booterà ma le route auth-protected falliranno con `5xx`. Solo `/health` (auth-free) funzionerà. NON usare questo path se PR 22 è già in main.

### F7.5. Step 6.5 — Bootstrap del primo super_admin officine (one-off)

> **Eseguire una sola volta**, dopo F7+F8 con i 4 valori reali Cognito. Crea un tenant seed in DB + un Cognito user super_admin per smoke test end-to-end auth. Da PR 22+; non applicabile pre-PR-22.

#### F7.5.a — Inserire un tenant seed in Supabase (SQL diretto)

Eseguire dal Supabase SQL Editor o psql collegato al production project. I 3 NOT NULL senza default sono i soli obbligatori — gli altri prendono i default da `packages/database/prisma/schema.prisma` model `Tenant` (`status='active'`, `billing_status='manual'`, `plan='starter'`, `settings='{}'`, `id=gen_random_uuid()`, `created_at=now()`).

```sql
INSERT INTO tenants (business_name, vat_number, email)
VALUES (
  'Officina Bootstrap',
  'IT00000000001',
  'admin@example.com'
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

#### F7.5.c — Smoke test end-to-end auth

1. Dal client (curl, Postman, Amplify CLI) eseguire `USER_SRP_AUTH` con `$ADMIN_EMAIL` + `$TEMP_PASSWORD`.
2. Cognito risponde con challenge `NEW_PASSWORD_REQUIRED`. Risolvere con un nuovo password forte.
3. Ottenere `IdToken` dal response finale.
4. `curl -H "Authorization: Bearer $ID_TOKEN" https://api.garageos.it/v1/vehicles` — attendersi `200` con array vuoto, o `404`.
5. Se ricevuto `401`: probabile mismatch issuer/audience nel JWT verifier vs pool/client ID nel secret. Verificare con la Cognito console + il secret content (`aws secretsmanager get-secret-value --secret-id garageos/production/app`).

### F8. Step 7 — Forza cold start della Lambda

Per far rileggere il secret aggiornato, invalidiamo i container Lambda warm aggiungendo una env var arbitraria:

```bash
aws lambda update-function-configuration \
  --function-name garageos-api \
  --region eu-central-1 \
  --environment 'Variables={NODE_ENV=production,AWS_LWA_PORT=8080,AWS_LWA_READINESS_CHECK_PATH=/health,AWS_LWA_ASYNC_INIT=true,APP_SECRETS_ARN=<incollare AppSecretsArn>,SECRET_REVISION=1}'
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

### F10. Step 9 — Abilitare push trigger (PR di follow-up)

Una volta confermato che il primo deploy manuale funziona, aprire un PR brevissimo che modifica `.github/workflows/deploy.yml` aggiungendo:

```yaml
on:
  push:
    branches: [main]
  workflow_dispatch:
    # … inputs invariati
```

Dopo il merge, ogni PR mergiata in `main` triggera deploy automatico, con il gate `environment: production` che richiede approval manuale.

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
pnpm --filter infrastructure cdk diff GarageosMainStack

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
pnpm --filter @garageos/infrastructure cdk deploy GarageosMainStack
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
