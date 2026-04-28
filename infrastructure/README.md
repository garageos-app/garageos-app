# `infrastructure/` — GarageOS AWS deploy

CDK in TypeScript. Deploya il backend GarageOS su AWS in `eu-central-1`.

In v1 (PR 21): scaffolding minimo per il primo deploy live.

- 1 stack OIDC separato (`GarageosOidcStack`)
- 1 stack principale (`GarageosMainStack`) con DNS + Secrets + Lambda API + APIGW HTTP v2

PR successivi: Cognito (PR 22), Storage+WAF (PR 23), SES+Scheduler+Monitoring (PR 24), Web app S3+CloudFront (PR 25).

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

Estrarre dal password manager dell'utente le due connection string Supabase, **rinominando `DATABASE_URL_DIRECT` → `DIRECT_URL`** (env.ts richiede `DIRECT_URL`, non `DATABASE_URL_DIRECT`).

```bash
aws secretsmanager update-secret \
  --secret-id garageos/production/app \
  --region eu-central-1 \
  --secret-string '{
    "DATABASE_URL": "<incollare DATABASE_URL Supabase>",
    "DIRECT_URL": "<incollare DATABASE_URL_DIRECT Supabase>",
    "COGNITO_OFFICINE_POOL_ID": "eu-central-1_PLACEHOLDER",
    "COGNITO_OFFICINE_CLIENT_ID": "PLACEHOLDER",
    "COGNITO_CLIENTI_POOL_ID": "eu-central-1_PLACEHOLDER",
    "COGNITO_CLIENTI_CLIENT_ID": "PLACEHOLDER",
    "SENTRY_DSN": "https://placeholder@sentry.io/0"
  }'
```

> I 4 placeholder Cognito soddisfano il regex di `env.ts` ma puntano a pool inesistenti. Permettono il boot della Lambda. Le route auth-protected falliranno con `5xx` fino a PR 22 (Cognito construct). `/health` è auth-free e funzionerà.

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
