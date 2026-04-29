# TLS verification proper — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminare `sslmode=no-verify` dalla connection string Supabase shippando il CA cert pubblico Supabase nel bundle Lambda e impostando `NODE_EXTRA_CA_CERTS` come env var, così il runtime Node valida il chain TLS end-to-end.

**Architecture:** Tre layer indipendenti — un asset PEM committato in repo (`infrastructure/assets/supabase-ca.crt`), una modifica al CDK construct Lambda (`commandHooks.afterBundling` copia l'asset nel zip + `environment.NODE_EXTRA_CA_CERTS` punta a `/var/task/supabase-ca.crt`), e una rotazione operativa post-merge del Secrets Manager da `sslmode=no-verify` a `sslmode=verify-full`. Zero edit a `packages/database/src/client.ts` o ad altri client TLS.

**Tech Stack:** AWS CDK v2 (`aws-lambda-nodejs.NodejsFunction`), Node.js runtime su Lambda, Prisma 7 + `@prisma/adapter-pg`, Supabase Postgres pooler, AWS Secrets Manager.

**Spec:** `docs/superpowers/specs/2026-04-29-tls-verification-proper-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `.gitignore` | Modify | Aggiungere `.local/` per non committare il cert dev path |
| `.gitattributes` | Create | Forzare LF su `.crt` per evitare line-ending mangling cross-platform |
| `infrastructure/assets/supabase-ca.crt` | Create | Vendored Supabase root CA (PEM, ~2 KB, scaricato da operatore) |
| `infrastructure/assets/SUPABASE_CA_NOTES.md` | Create | Origin URL + expiry tracking + rotation history |
| `infrastructure/scripts/copy-runtime-assets.cjs` | Create | Build-time hook che copia gli asset runtime nel Lambda outputDir + fail-fast |
| `infrastructure/lib/constructs/lambda-api.ts` | Modify | Aggiungere `NODE_EXTRA_CA_CERTS` a `environment` + secondo step in `commandHooks.afterBundling` |
| `packages/api/.env.example` | Modify | Documentare opt-in `NODE_EXTRA_CA_CERTS` per dev locale |
| `packages/database/.env.example` | Modify | Stesso snippet per simmetria |
| `infrastructure/README.md` | Modify | Nuova sezione "TLS verification rotation runbook" |

**Note di decomposizione:**
- `copy-runtime-assets.cjs` è un nuovo file (non è un edit di `strip-prisma-bloat.cjs`) perché ha una responsabilità diversa (copy IN, vs strip OUT) e potrà ospitare future asset (es. SES root CA) senza accoppiare le due logiche.
- Nessun snapshot test CDK aggiunto: `infrastructure/test/` non esiste oggi, aprirlo solo per questa PR sarebbe sproporzionato. Verificare invece che il bundle contenga il cert post-build con `unzip -l` (manuale, vedi Task 8 step manuale).
- Nessun edit a `packages/database/src/client.ts`: la verifica avviene in OpenSSL native via `NODE_EXTRA_CA_CERTS`, completamente trasparente al codice.

---

## Pre-requisito operatore (fuori plan)

**Prima di iniziare il Task 2**, l'operatore (Michele) deve scaricare il cert root Supabase pubblico:

1. Navigare a `https://supabase.com/dashboard/project/<project-ref>/settings/database`.
2. Sezione "SSL Configuration" → click "Download certificate" (button label può variare). Il file scaricato è tipicamente `prod-ca-2021.crt`.
3. Salvarlo localmente in un percorso temporaneo (es. `~/Downloads/supabase-ca.crt`).
4. Verificare che NON sia un cert privato cliente-specifico ma il root CA pubblico:
   - `openssl x509 -in ~/Downloads/supabase-ca.crt -noout -subject` → output deve contenere `O=Supabase`
   - `openssl x509 -in ~/Downloads/supabase-ca.crt -noout -dates` → annotare `notAfter` (scadenza, andrà nel notes file).

Questo step **non lo fa Claude** (non ho accesso al Supabase dashboard).

---

## Task 1: Add `.local/` to `.gitignore` and `.crt` LF rule

**Files:**
- Modify: `.gitignore`
- Create: `.gitattributes`

- [ ] **Step 1: Verify current `.gitignore` doesn't already cover `.local/`**

Run: `grep -n "\.local" .gitignore`
Expected output: matches solo per `.env.local` o `.env.*.local`, **non** per `.local/` directory standalone.

- [ ] **Step 2: Append `.local/` rule to `.gitignore`**

Append at the end of the existing `.gitignore`:

```
# Local-only assets (per-developer, e.g. downloaded TLS CA cert
# for prod pooler verification — see packages/api/.env.example).
.local/
```

- [ ] **Step 3: Create `.gitattributes`**

Crea `.gitattributes` al root del repo con:

```
# Keep PEM/CRT files LF-normalized so Node's TLS parser sees the
# canonical line endings regardless of host OS (Windows checkout
# would otherwise rewrite to CRLF on autocrlf=true).
*.crt text eol=lf
*.pem text eol=lf
```

- [ ] **Step 4: Verify rule application**

Run: `git check-ignore -v .local/anything`
Expected: matches `.local/` rule.

Run: `git check-attr -a infrastructure/assets/supabase-ca.crt`
Expected (anche se il file non esiste ancora, l'attributo si applica al pattern):
- `text: set`
- `eol: lf`

- [ ] **Step 5: Commit**

```bash
git add .gitignore .gitattributes
git commit -m "chore(repo): gitignore .local/ and force LF on PEM/CRT files"
```

---

## Task 2: Vendor Supabase CA cert + notes file

**Pre-requisito:** lo step "Pre-requisito operatore" sopra deve essere completato.

**Files:**
- Create: `infrastructure/assets/supabase-ca.crt`
- Create: `infrastructure/assets/SUPABASE_CA_NOTES.md`

- [ ] **Step 1: Create `infrastructure/assets/` directory**

Run: `mkdir -p infrastructure/assets`

- [ ] **Step 2: Copy the downloaded cert into the repo**

Run: `cp ~/Downloads/supabase-ca.crt infrastructure/assets/supabase-ca.crt`

(adatta il path sorgente se l'operatore ha salvato altrove)

- [ ] **Step 3: Verify the cert is a valid PEM root CA**

```bash
openssl x509 -in infrastructure/assets/supabase-ca.crt -noout -subject -issuer -dates
```

Expected output (subject e issuer dovrebbero coincidere — è un self-signed root):
```
subject=C=US, O=Supabase, ...
issuer=C=US, O=Supabase, ...
notBefore=...
notAfter=...
```

Annotare il `notAfter` per il prossimo step.

- [ ] **Step 4: Create `SUPABASE_CA_NOTES.md`**

```markdown
# Supabase CA certificate

## Origin

Downloaded from `https://supabase.com/dashboard/project/<project-ref>/settings/database`,
section "SSL Configuration" → "Download certificate". Public root CA used by Supabase
to sign their Postgres pooler intermediate certificates.

This file is NOT a secret — it is the public root that any client validating the
Supabase pooler chain must trust. It is committed to the repo so the Lambda bundle
is reproducible without network access at deploy time.

## Current cert metadata

- **Subject:** `<paste output of `openssl x509 -in supabase-ca.crt -noout -subject`>`
- **Issuer:** `<paste output of `openssl x509 -in supabase-ca.crt -noout -issuer`>`
- **Valid until:** `<paste notAfter from openssl, e.g. 2031-04-26T...Z>`
- **Vendored on:** 2026-04-29 (PR — TLS verification proper)

## Rotation

When Supabase publishes a new root CA (last rotation: 2021), repeat the download
step above and replace this file with a commit. Update the metadata block accordingly.

If `notAfter` is approaching (within 12 months), proactively check the Supabase
dashboard for a successor cert before expiry triggers a production outage.

## Verification commands

```bash
# Subject and issuer
openssl x509 -in infrastructure/assets/supabase-ca.crt -noout -subject -issuer

# Validity dates
openssl x509 -in infrastructure/assets/supabase-ca.crt -noout -dates

# Full text
openssl x509 -in infrastructure/assets/supabase-ca.crt -noout -text
```
```

Sostituire i placeholder `<paste …>` con l'output reale dei comandi `openssl` dello Step 3.

- [ ] **Step 5: Commit**

```bash
git add infrastructure/assets/supabase-ca.crt infrastructure/assets/SUPABASE_CA_NOTES.md
git commit -m "feat(infra): vendor Supabase root CA cert for Lambda TLS verification"
```

---

## Task 3: Build hook script `copy-runtime-assets.cjs`

**Files:**
- Create: `infrastructure/scripts/copy-runtime-assets.cjs`

Mirror dello stile di `strip-prisma-bloat.cjs` (CommonJS, fail-fast su argv mancante, esce non-zero su errore).

- [ ] **Step 1: Create the script**

Crea `infrastructure/scripts/copy-runtime-assets.cjs`:

```js
/* eslint-disable @typescript-eslint/no-require-imports */

// Copy runtime asset files (e.g. the Supabase root CA cert) from
// infrastructure/assets/ into a freshly bundled Lambda outputDir,
// called from LambdaApiConstruct.bundling.commandHooks.afterBundling.
//
// Usage:  node copy-runtime-assets.cjs <outputDir>
//
// Files copied:
//   - infrastructure/assets/supabase-ca.crt → <outputDir>/supabase-ca.crt
//
// Fails fast (exit 1) if a source file is missing or the destination
// ends up empty after copy — both are signs the bundle is broken and
// the Lambda would fail at TLS handshake time anyway.

const fs = require('node:fs');
const path = require('node:path');

const outputDir = process.argv[2];
if (!outputDir) {
  console.error('copy-runtime-assets.cjs: missing outputDir argument');
  process.exit(1);
}

const assetsDir = path.resolve(__dirname, '..', 'assets');

const assets = [
  { src: 'supabase-ca.crt', dest: 'supabase-ca.crt' },
];

for (const { src, dest } of assets) {
  const srcPath = path.join(assetsDir, src);
  const destPath = path.join(outputDir, dest);

  if (!fs.existsSync(srcPath)) {
    console.error(`copy-runtime-assets.cjs: source not found: ${srcPath}`);
    process.exit(1);
  }

  fs.copyFileSync(srcPath, destPath);

  const stat = fs.statSync(destPath);
  if (stat.size === 0) {
    console.error(`copy-runtime-assets.cjs: destination empty after copy: ${destPath}`);
    process.exit(1);
  }

  console.log(
    `copy-runtime-assets.cjs: ${src} (${stat.size} bytes) → ${path.relative(process.cwd(), destPath)}`,
  );
}
```

- [ ] **Step 2: Smoke-test the script manually**

Crea una dir temp e gira lo script:

```bash
TMPDIR=$(mktemp -d)
node infrastructure/scripts/copy-runtime-assets.cjs "$TMPDIR"
ls -la "$TMPDIR"
rm -rf "$TMPDIR"
```

Expected output:
- Stdout: `copy-runtime-assets.cjs: supabase-ca.crt (XXXX bytes) → /tmp/.../supabase-ca.crt`
- `ls`: il file `supabase-ca.crt` presente nella temp dir
- Exit code 0

- [ ] **Step 3: Negative path — missing argv**

Run: `node infrastructure/scripts/copy-runtime-assets.cjs`

Expected:
- Stderr: `copy-runtime-assets.cjs: missing outputDir argument`
- Exit code 1

- [ ] **Step 4: Negative path — missing source**

Temporaneamente rinomina il cert e riprova:

```bash
mv infrastructure/assets/supabase-ca.crt infrastructure/assets/supabase-ca.crt.bak
TMPDIR=$(mktemp -d)
node infrastructure/scripts/copy-runtime-assets.cjs "$TMPDIR"; echo "exit=$?"
mv infrastructure/assets/supabase-ca.crt.bak infrastructure/assets/supabase-ca.crt
rm -rf "$TMPDIR"
```

Expected:
- Stderr: `copy-runtime-assets.cjs: source not found: .../assets/supabase-ca.crt`
- `exit=1`

**Importante:** verifica che `mv` indietro al nome originale sia avvenuto. Se hai dimenticato, il commit successivo droppererebbe il cert.

- [ ] **Step 5: Commit**

```bash
git add infrastructure/scripts/copy-runtime-assets.cjs
git commit -m "feat(infra): add copy-runtime-assets build hook for Lambda zip"
```

---

## Task 4: CDK Lambda construct — wire env var + commandHook

**Files:**
- Modify: `infrastructure/lib/constructs/lambda-api.ts`

- [ ] **Step 1: Add `NODE_EXTRA_CA_CERTS` to the Lambda environment**

In `infrastructure/lib/constructs/lambda-api.ts`, individua il blocco `environment` (intorno alla riga 103 nello stato pre-PR):

```ts
      environment: {
        NODE_ENV: 'production',
        APP_SECRETS_ARN: props.appSecret.secretArn,
      },
```

Sostituiscilo con:

```ts
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
      },
```

- [ ] **Step 2: Add the copy step to `commandHooks.afterBundling`**

Individua il blocco `afterBundling` (intorno alla riga 126 nello stato pre-PR):

```ts
          afterBundling: (_inputDir, outputDir) => [
            // Prisma 7's @prisma/client ships ~75 MB of WASM ...
            //   ...
            `node "${path.join(__dirname, '..', '..', 'scripts', 'strip-prisma-bloat.cjs')}" "${outputDir}"`,
          ],
```

Aggiungi un secondo elemento al return array:

```ts
          afterBundling: (_inputDir, outputDir) => [
            // Prisma 7's @prisma/client ships ~75 MB of WASM ...
            //   ...  (commento esistente invariato)
            `node "${path.join(__dirname, '..', '..', 'scripts', 'strip-prisma-bloat.cjs')}" "${outputDir}"`,
            // Copy runtime assets (Supabase CA cert) into the bundle
            // root so /var/task/supabase-ca.crt is reachable by
            // NODE_EXTRA_CA_CERTS at Lambda cold start. See
            // infrastructure/scripts/copy-runtime-assets.cjs and
            // infrastructure/assets/SUPABASE_CA_NOTES.md.
            `node "${path.join(__dirname, '..', '..', 'scripts', 'copy-runtime-assets.cjs')}" "${outputDir}"`,
          ],
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm --filter @garageos/infrastructure typecheck`
(oppure `pnpm -r typecheck` se il filter non esiste — il workspace si chiama come da `infrastructure/package.json`)

Expected: nessun errore. Se compaiono errori, leggili — di solito mancato match di property name `commandHooks` o `environment` indica un edit nella posizione sbagliata.

- [ ] **Step 4: CDK synth dry-run (opzionale ma fortemente raccomandato)**

```bash
cd infrastructure
pnpm cdk synth GarageosMainStack > /tmp/synth-out.yaml 2>&1
echo "exit=$?"
grep -A 2 "NODE_EXTRA_CA_CERTS" /tmp/synth-out.yaml
cd ..
```

Expected:
- `exit=0`
- Output `grep`: la env var compare nel CFN template della Lambda con valore `/var/task/supabase-ca.crt`.

Se `cdk synth` fallisce con un errore di asset bundling sul commandHook (es. esbuild non trova `copy-runtime-assets.cjs`), verificare il path `path.join(__dirname, '..', '..', 'scripts', 'copy-runtime-assets.cjs')` rispetto al filesystem reale (deve risolvere a `<repo>/infrastructure/scripts/copy-runtime-assets.cjs`).

- [ ] **Step 5: Commit**

```bash
git add infrastructure/lib/constructs/lambda-api.ts
git commit -m "feat(infra): wire NODE_EXTRA_CA_CERTS + ship Supabase CA in Lambda zip"
```

---

## Task 5: Local dev docs — `.env.example` updates

**Files:**
- Modify: `packages/api/.env.example`
- Modify: `packages/database/.env.example`

- [ ] **Step 1: Append snippet to `packages/api/.env.example`**

Append in fondo al file:

```
# --- Local TLS verification (optional, prod-only flow) ---
# By default local dev runs against a local/Testcontainers Postgres
# where TLS is either disabled or self-signed and `sslmode` is omitted
# from DATABASE_URL — no extra config needed. This var is only
# relevant if you want to run the local API against the prod Supabase
# pooler with proper CA verification:
#   1. Download the CA cert from
#      https://supabase.com/dashboard/project/_/settings/database
#   2. Save it as packages/api/.local/supabase-ca.crt (gitignored)
#   3. Uncomment the line below
#   4. Set DATABASE_URL to the prod pooler URL with sslmode=verify-full
# NODE_EXTRA_CA_CERTS=./.local/supabase-ca.crt
```

- [ ] **Step 2: Append snippet to `packages/database/.env.example`**

Stesso snippet ma con il path locale `packages/database/.local/supabase-ca.crt` (i due package leggono `.env.local` da working directory diverse durante `pnpm --filter <pkg> ...`).

```
# --- Local TLS verification (optional, prod-only flow) ---
# By default local dev runs against a local/Testcontainers Postgres
# where TLS is either disabled or self-signed and `sslmode` is omitted
# from DATABASE_URL — no extra config needed. This var is only
# relevant if you want to run the database package (e.g. prisma
# migrate) against the prod Supabase pooler with proper CA verification:
#   1. Download the CA cert from
#      https://supabase.com/dashboard/project/_/settings/database
#   2. Save it as packages/database/.local/supabase-ca.crt (gitignored)
#   3. Uncomment the line below
#   4. Set DATABASE_URL/DIRECT_URL to the prod pooler URL with sslmode=verify-full
# NODE_EXTRA_CA_CERTS=./.local/supabase-ca.crt
```

- [ ] **Step 3: Verify secretlint still passes on .env.example files**

Run: `pnpm exec secretlint "packages/**/.env.example"` (or whatever the local secretlint invocation is — vedi `package.json` scripts root).

Expected: 0 errors. (Non dovrebbe trovarne — i path locali non sono connection string.)

- [ ] **Step 4: Commit**

```bash
git add packages/api/.env.example packages/database/.env.example
git commit -m "docs(api,database): document opt-in NODE_EXTRA_CA_CERTS for local dev"
```

---

## Task 6: Runbook — TLS rotation section in `infrastructure/README.md`

**Files:**
- Modify: `infrastructure/README.md`

- [ ] **Step 1: Locate the right insertion point**

Run: `grep -n "^## " infrastructure/README.md`

Trova dove vivono le sezioni operative tipo "F7 Populate Secrets Manager" / "F10 Push trigger". L'inserimento naturale è subito dopo F10 o in fondo al file, come nuova sezione "TLS verification rotation".

Se la struttura corrente non ha sezioni numerate F1-F10 ma usa H2 tematici, scegli la posizione narrativamente coerente (es. dopo "Post-deploy operations" se esiste).

- [ ] **Step 2: Add the new section**

Aggiungi questa sezione (adattando il livello di header al circostante):

````markdown
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
````

- [ ] **Step 3: Verify markdown still parses**

Run: `pnpm exec prettier --check infrastructure/README.md`

Se fallisce: `pnpm exec prettier --write infrastructure/README.md` e re-stage.

- [ ] **Step 4: Commit**

```bash
git add infrastructure/README.md
git commit -m "docs(infra): add TLS verification rotation runbook"
```

---

## Task 7: Pre-push gate — typecheck the whole repo

**Files:** none.

- [ ] **Step 1: Run repo-wide typecheck**

Run: `pnpm -r typecheck`

Expected: 0 errors. Questo è lo stesso comando del pre-push hook quindi `git push` riusciva o falliva con lo stesso output.

Se fallisce: leggere il package responsabile, fixare in `infrastructure/lib/constructs/lambda-api.ts` (l'unico file TS toccato dal piano). Possibili motivi:
- Trailing virgola mancante / sintassi errata sul nuovo elemento del return array
- Property name typo su `NODE_EXTRA_CA_CERTS`
- Missing import (non dovrebbe — `path` è già importato in cima al file)

---

## Task 8: Push branch + open PR

**Pre-condition:** tutti i commit dei Task 1-6 sono sulla feature branch `docs/spec-tls-verification-proper` (creata dal brainstorming) — verifica con `git log --oneline main..HEAD`.

- [ ] **Step 1: Rename the branch (cosmetic)**

La branch è stata creata con prefix `docs/` quando conteneva solo lo spec. Ora che contiene anche `feat(infra)` + altri tipi, rinominala:

```bash
git branch -m feat/tls-verification-proper
```

- [ ] **Step 2: Push to origin**

```bash
git push -u origin feat/tls-verification-proper
```

Se il pre-push hook fallisce con un errore di typecheck non visto in Task 7, fixare e ripetere il push.

- [ ] **Step 3: Open the PR**

```bash
gh pr create --title "feat(infra): proper TLS verification on Supabase pooler" \
  --body "$(cat <<'EOF'
## What

Replace the bootstrap `sslmode=no-verify` workaround with proper TLS chain
validation on the Supabase Postgres pooler. Achieved by vendoring the public
Supabase root CA (`infrastructure/assets/supabase-ca.crt`) and pointing
`NODE_EXTRA_CA_CERTS` at it from the Lambda runtime — fully transparent to
application code.

## Why

Tech-debt entry "DATABASE_URL/DIRECT_URL con sslmode=no-verify" from the
2026-04-29 bootstrap session. `no-verify` skips chain validation and was
acceptable only with no real customer traffic. Resolving this is a
prerequisite to onboarding the first workshop with real PII (BR-151).

Spec: `docs/superpowers/specs/2026-04-29-tls-verification-proper-design.md`
Plan: `docs/superpowers/plans/2026-04-29-tls-verification-proper.md`

## Implementation notes

- Approach A from the spec (`NODE_EXTRA_CA_CERTS`) chosen over programmatic
  `PrismaPg({ ssl: { ca } })` for zero-code-change in `client.ts` and
  future-proofing other TLS clients.
- Cert vendored in repo (not Secrets Manager) because it's public info and
  guarantees deterministic builds.
- `copy-runtime-assets.cjs` is a new build-hook script mirroring the style
  of `strip-prisma-bloat.cjs`, fail-fast on missing source.

## Tests

- [ ] Manual smoke-test of `copy-runtime-assets.cjs` (positive + 2 negative paths)
- [ ] `pnpm -r typecheck` clean
- [ ] CDK synth dry-run produces a template with `NODE_EXTRA_CA_CERTS=/var/task/supabase-ca.crt`
- [ ] Post-deploy smoke (Step 1 of runbook): `/health` → 200
- [ ] Post-rotate smoke (Step 5 of runbook): `/health` and `/v1/users/me` → 200, no TLS errors in CloudWatch

## Post-merge operator runbook

Follow `infrastructure/README.md` → "TLS verification rotation runbook"
section (added in this PR). Five steps, each reversible in < 2 min.

## Checklist

- [x] Spec + plan committed
- [x] Code follows existing CommonHooks pattern (`strip-prisma-bloat.cjs`)
- [ ] Types compile (`pnpm -r typecheck`)
- [ ] CDK synth produces expected template
- [ ] No new dependencies added
- [ ] No secrets committed (CA cert is public, verified via `openssl`)
- [ ] APPENDICE_C cross-check N/A (this PR predates that doc's TLS section; will revisit during ADR/APPENDICE_C update PR — separate cluster item #4)
EOF
)"
```

- [ ] **Step 4: Watch CI**

```bash
gh pr checks --watch
```

Se fallisce: investigare l'errore, fixare, push follow-up commit (mai amend on a pushed branch).

- [ ] **Step 5: Hand off to Michele for review + merge**

Stop here. Michele esegue:
1. Review PR su GitHub
2. Squash-merge
3. Esegue il runbook §4 da `infrastructure/README.md` (Step 1 deploy → Step 5 smoke)
4. Aggiorna `project_tech_debt.md` marcando la voce `[resolved 2026-04-29, PR #<num>]`

---

## Self-review

**Spec coverage check:**
- §3.1 Asset → Task 2 ✓
- §3.2 CDK → Task 4 ✓
- §3.3 Connection string rotation → Task 6 (runbook) + post-merge operator action ✓
- §4 Runbook (5 step) → Task 6 ✓
- §5 Local dev → Task 5 ✓
- §6 Error handling → Task 6 (failure modes section) ✓
- §7 Testing → Task 3 (script smoke) + Task 4 step 4 (CDK synth) + Task 8 (manual smoke per acceptance) ✓
- §8 Acceptance criteria → coperti tutti dai Task 1-8 ✓
- §9 Open questions:
  - verify-full vs verify-ca → runbook Task 6 §"Failure modes" ✓
  - CA rotation tracking → Task 2 step 4 (SUPABASE_CA_NOTES.md) ✓
  - CDK snapshot test → resolved NO (vedi File Structure note) ✓

**Placeholder scan:** zero TBD/TODO/"figure out"/"appropriate". Tutti i blocchi codice sono completi e pronti da incollare. ✓

**Type/path consistency:**
- `infrastructure/assets/supabase-ca.crt` referenziato consistentemente in: Task 2 (creation), Task 3 script (resolved via `path.resolve(__dirname, '..', 'assets')`), Task 4 (commento env var), Task 6 runbook. ✓
- `/var/task/supabase-ca.crt` consistente in Task 4 env var + Task 6 runbook + .env.example commenti. ✓
- `copy-runtime-assets.cjs` referenziato consistentemente in Task 3 (creation), Task 4 (commandHooks invocation). ✓
- `NODE_EXTRA_CA_CERTS` consistente in tutti i task. ✓
- Branch name change (`docs/...` → `feat/...`) gestito esplicitamente in Task 8 step 1. ✓
