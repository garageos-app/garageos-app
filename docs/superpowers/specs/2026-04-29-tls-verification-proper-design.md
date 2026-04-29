# PR — TLS verification proper (rimpiazzare `sslmode=no-verify`)

**Data:** 2026-04-29
**Stato:** spec
**Spec parent:** tech debt ledger `project_tech_debt.md` sezione "Bootstrap operativo (sessione 2026-04-29)" → voce `[open] DATABASE_URL/DIRECT_URL con sslmode=no-verify`
**Hardening cluster:** PR 1 di 5 (TLS → least-priv role → runbook fix → ADR/APPENDICE_C update LWA pivot → F10 push trigger). Ordine voluto: la TLS è codice + asset + runbook, le altre 4 sono prevalentemente operative o doc-only.

---

## 1. Obiettivo

Eliminare `sslmode=no-verify` dalla connection string Supabase e sostituirlo con verifica TLS reale del chain (`sslmode=verify-full`, fallback `verify-ca`), shippando il CA cert pubblico Supabase come asset dentro il bundle Lambda e impostando `NODE_EXTRA_CA_CERTS` come variabile di ambiente runtime.

**Motivazione:** `sslmode=no-verify` skippa la cert-chain validation, lasciando l'API esposta a MITM verso il pooler Supabase. Inaccettabile per produzione con dati GDPR (BR-151 PII customer). Il workaround è stato approvato in fase di bootstrap senza traffico reale, ma va chiuso prima di esporre l'API a clienti veri.

**Non in scope (deferred a PR successivi):**
- Rotazione del runtime DB role da `postgres` superuser a `garageos_app` least-privilege (PR 2 del cluster hardening).
- Aggiornamento ADR-0001 e APPENDICE_C per il pivot LWA → `@fastify/aws-lambda` (PR 4).
- Fix runbook gaps F7.5 (PR 3).
- F10 push trigger CI/CD (PR 5).
- Modifiche al codice di `packages/database/src/client.ts` o ad altri client TLS — la soluzione è 100% trasparente al livello applicativo.

## 2. Contesto e prerequisiti

**Stato di partenza:**
- API live in produzione su `https://api.garageos.aifollyadvisor.com` (post PR #41).
- Secrets Manager `garageos/production/app` contiene DATABASE_URL e DIRECT_URL Supabase pooler `aws-1-eu-central-1.pooler.supabase.com:6543/5432` con `sslmode=no-verify` appended.
- `packages/api/src/config/secrets.ts:loadSecretsIntoEnv()` legge il secret JSON e copia ogni chiave in `process.env` se non già definita. Connection string passa verbatim al Prisma adapter.
- `packages/database/src/client.ts:33` fa `new PrismaPg({ connectionString })` senza opzioni SSL programmatic.
- `infrastructure/lib/constructs/lambda-api.ts` usa `aws-lambda-nodejs.NodejsFunction` con `commandHooks.afterBundling` già configurato per girare `strip-prisma-bloat.cjs` post-esbuild.

**Causa originale del workaround:** cold start Lambda falliva con `Error opening a TLS connection: self-signed certificate in certificate chain` dal `@prisma/adapter-pg` verso il pooler Supabase. Il pooler usa cert con CA radice non presente nel trust store Node default (Supabase emette i propri certs intermedi sotto il proprio root pubblico `prod-ca-2021.crt`).

**Vincoli:**
- Zero downtime: la rotazione deve avvenire senza finestra di unavailability sull'API live.
- Hard limit 1500 righe diff PR (alert 1200). Stima questa PR: ~150-200 righe (asset + 2 edit CDK + runbook + .env.example).
- Niente credenziali in chat o git.
- Niente CA cert in Secrets Manager — è informazione pubblica, vive in repo come asset committato.
- Nessun deploy eseguito da Claude. Il deploy + rotate secret lo esegue Michele manualmente seguendo il runbook in §7.

## 3. Architettura

### 3.1 Layer 1 — Asset

`infrastructure/assets/supabase-ca.crt` — file PEM committato in repo.

Sorgente: scaricato una tantum da `https://supabase.com/dashboard/project/_/settings/database` (sezione "SSL Configuration" → "Download certificate"), oppure via wget da `https://supabase.com/dashboard/project/_/settings/database/certificates/prod-ca-2021.crt` (stesso file pubblico). Si tratta di un cert root Supabase usato per firmare i pooler intermedi, ~2 KB, rotation prevista raramente (ultima rotazione: 2021).

**Perché in repo invece che in Secrets Manager o fetched at deploy time:**
- È informazione pubblica, non un segreto. JSON-escaping di PEM multi-line in Secrets Manager è goffo e aggiunge un secondo asset da gestire.
- Repository-vendored = deterministic builds. CI riproduce esattamente lo stesso bundle senza dipendenze di rete a deploy time.
- Rotation: quando Supabase pubblicherà un nuovo CA, sostituire il file con un commit. Reviewable in PR (chiunque può comparare il diff PEM).

**`.gitattributes`:** considerare `*.crt -text` per evitare line ending mangling su Windows. Da verificare al primo commit del file.

### 3.2 Layer 2 — CDK

Due edit a `infrastructure/lib/constructs/lambda-api.ts`:

**A. `commandHooks.afterBundling` aggiunge un secondo step**, mirror del pattern già esistente per `strip-prisma-bloat.cjs`. La logica del copy + fail-fast vive in un nuovo script `infrastructure/scripts/copy-runtime-assets.cjs` (vedi §7.2 per il contenuto):

```ts
afterBundling: (_inputDir, outputDir) => [
  // existing strip
  `node "${path.join(__dirname, '..', '..', 'scripts', 'strip-prisma-bloat.cjs')}" "${outputDir}"`,
  // NEW: copy Supabase CA cert (and any future runtime assets) into the
  // Lambda zip root. Lambda extracts into /var/task/, so the cert lands
  // at /var/task/supabase-ca.crt — same path NODE_EXTRA_CA_CERTS points to.
  // Centralizing in a .cjs script avoids cross-platform shell quoting issues
  // (Linux CI bash vs Windows cmd.exe) and gives us a single place to add
  // future runtime assets.
  `node "${path.join(__dirname, '..', '..', 'scripts', 'copy-runtime-assets.cjs')}" "${outputDir}"`,
],
```

**B. `environment` aggiunge la env var:**

```ts
environment: {
  NODE_ENV: 'production',
  APP_SECRETS_ARN: props.appSecret.secretArn,
  // NEW: instruct Node to merge the bundled Supabase root CA into the
  // default trust store at process startup. Required for sslmode=verify-full
  // on connections to the Supabase transaction pooler.
  // See: https://nodejs.org/api/cli.html#node_extra_ca_certsfile
  NODE_EXTRA_CA_CERTS: '/var/task/supabase-ca.crt',
},
```

**Nessun edit** a `secrets.ts` (il CA non è un segreto), `client.ts` (Prisma adapter resta come oggi), `env.ts` (nessuna nuova env var validata — `NODE_EXTRA_CA_CERTS` è consumata dal runtime Node prima ancora che `env.ts` sia importato).

### 3.3 Layer 3 — Connection string in Secrets Manager

Change operativo, non-codice. `aws secretsmanager update-secret` con il nuovo valore JSON dove DATABASE_URL e DIRECT_URL hanno `sslmode=verify-full` invece di `sslmode=no-verify`.

La modifica è solo un append/replace della query string del secret JSON: dove oggi compare `?sslmode=no-verify`, dopo deve comparire `?sslmode=verify-full`. Tutto il resto della connection string (scheme `postgresql`, user, password, host, port, db) resta identico ai valori già presenti nel secret.

Fallback se `verify-full` fallisce per hostname mismatch sul pooler:
- `sslmode=verify-ca`: valida il chain (Supabase root → intermediate → leaf) ma skippa hostname check. Resta valido come postura di sicurezza — il chain dimostra che il server controlla la chiave privata corrispondente al cert firmato dal CA Supabase, anche senza hostname match. Accettabile per un servizio managed dove il pooler hostname è dinamico.
- `sslmode=no-verify`: solo come ultimo rollback se nessun altro mode funziona. Non dovrebbe essere necessario se il cert è quello giusto.

## 4. Rotazione zero-downtime — runbook deploy

Cinque step, ciascuno reversibile con < 2 min rollback:

**Step 1 — Merge PR + deploy CDK**
- Merge della PR su `main` via squash merge (workflow standard).
- Deploy manuale CDK da terminale operatore: `pnpm --filter @garageos/infrastructure cdk deploy GarageosMainStack`.
- Risultato: Lambda zip ora contiene `/var/task/supabase-ca.crt`, env var `NODE_EXTRA_CA_CERTS` settato.
- Connection string nel secret è ancora `sslmode=no-verify` → app continua a girare identico a prima. Il cert è "armato ma inerte".
- **Smoke test:** `curl https://api.garageos.aifollyadvisor.com/health` → 200, `database: ok`.
- Rollback: `cdk deploy` versione precedente. ~3 min.

**Step 2 — Verifica cert nel zip**
- `aws lambda get-function --function-name garageos-api --query Code.Location --output text` → URL pre-signed
- `curl -o lambda.zip "<url>" && unzip -l lambda.zip | grep supabase-ca.crt` → conferma presenza
- Skip se hai già fiducia nel commandHook (la sezione 5 §test 2 fail-fasta a build time).

**Step 3 — Rotate secret a `verify-full`**
- Aggiornare DATABASE_URL e DIRECT_URL nel JSON del secret `garageos/production/app` con `sslmode=verify-full`. Comando:

```bash
# Pull current value, modify, push back.
aws secretsmanager get-secret-value --secret-id garageos/production/app \
  --query SecretString --output text > /tmp/secret.json
# Edit /tmp/secret.json sostituendo sslmode=no-verify con sslmode=verify-full
aws secretsmanager update-secret --secret-id garageos/production/app \
  --secret-string file:///tmp/secret.json
shred /tmp/secret.json
```

- Rollback: ripeti il comando con `sslmode=verify-ca` o `sslmode=no-verify`. ~1 min.

**Step 4 — Force Lambda cold start**

Warm container Lambda hanno già DATABASE_URL caricato in memoria — il rotate al §3 non li tocca. Per invalidarli, settiamo una nuova env var dummy `SECRET_REVISION` che forza la ricreazione di tutte le execution environment.

**Importante:** `aws lambda update-function-configuration --environment Variables={...}` **sostituisce** l'intero set di env vars, non fa merge. Per non perdere `NODE_ENV` / `APP_SECRETS_ARN` / `NODE_EXTRA_CA_CERTS` esistenti, leggere il set corrente, mergare, push:

```bash
CURRENT=$(aws lambda get-function-configuration \
  --function-name garageos-api \
  --query Environment.Variables --output json)
NEW=$(echo "$CURRENT" | jq '. + {SECRET_REVISION: "2"}')
aws lambda update-function-configuration \
  --function-name garageos-api \
  --environment "Variables=$NEW"
```

Bumpare `SECRET_REVISION` (`"2"` → `"3"` …) ogni volta che si rotea il secret in futuro.

Alternativa hands-off: aspettare ~15-30 min di inattività e AWS Lambda recicla i warm container naturalmente.

**Step 5 — Smoke test post-rotate**
- `curl https://api.garageos.aifollyadvisor.com/health` → 200, `database: ok`.
- `curl https://api.garageos.aifollyadvisor.com/v1/users/me -H "Authorization: Bearer <jwt>"` → 200 con full user JSON.
- Inspect CloudWatch logs `/aws/lambda/garageos-api` per assenza di errori TLS.
- Se OK → done. Se fail con `Hostname/IP does not match certificate's altnames` → fallback a `sslmode=verify-ca` ripetendo Step 3-4. Se fail con altro cert error → debug offline (probabilmente cert sbagliato, verificare PEM).

## 5. Local dev story

Aggiunta a `packages/api/.env.example`:

```bash
# Local TLS verification (optional, prod-only flow).
# By default local dev runs against a local/Testcontainers Postgres where
# TLS is either disabled or self-signed and sslmode is omitted from the
# DATABASE_URL — no extra config needed. This var is only relevant if you
# want to run the local API against the prod Supabase pooler:
#   1. Download the CA cert from supabase.com/dashboard/project/_/settings/database
#   2. Save it as packages/api/.local/supabase-ca.crt (gitignored)
#   3. Uncomment the line below
#   4. Set DATABASE_URL to the prod pooler URL with sslmode=verify-full
# NODE_EXTRA_CA_CERTS=./.local/supabase-ca.crt
```

`.gitignore` deve coprire `.local/`. Verificare al primo commit (probabilmente già coperto dalla regola standard, ma da confermare).

`packages/database/.env.example` riceve uno snippet equivalente per simmetria.

## 6. Error handling

Un solo failure mode da progettare esplicitamente: hostname mismatch tra cert e connection URL.

- **Sintomo runtime:** `Hostname/IP does not match certificate's altnames` o `unable to verify the first certificate`.
- **Probabilità:** bassa ma non zero. Il pooler Supabase usa cert wildcard `*.pooler.supabase.com` che dovrebbe matchare `aws-1-eu-central-1.pooler.supabase.com`, ma comportamenti inattesi sui Subject Alternative Names (SAN) sono possibili.
- **Mitigation:** documentato nel runbook §4 Step 5 che `sslmode=verify-ca` è il fallback accettabile. Non implementare auto-fallback nel codice — vogliamo che il primo deploy fallisca rumoroso così l'operatore se ne accorga e prenda decisione consapevole sul mode finale.

Tutti gli altri scenari producono errori espliciti dal runtime Node:
- Cert mancante nel zip → cold start fallisce con `ENOENT: no such file or directory, open '/var/task/supabase-ca.crt'` al primo TLS handshake. Mitigato da fail-fast nel commandHook (§5 test 2).
- Env var `NODE_EXTRA_CA_CERTS` non settato → comportamento pre-PR (cert chain non riconosciuto, `verify-full` fallisce). Mitigato da deploy gating: il merge della PR include sempre lo step env var.
- Cert scaduto → Node lancia `certificate has expired`. Verificare expiration al download iniziale (`openssl x509 -in supabase-ca.crt -noout -dates`) e committare in `infrastructure/assets/SUPABASE_CA_NOTES.md` la data di expiry per future rotation tracking.

## 7. Testing

Strategia: minimal tests in unit (la TLS verification è OpenSSL native, non c'è logica TS testabile), affidamento ai test esistenti per regression, smoke manuale post-deploy come gate finale.

### 7.1 CDK snapshot test (opzionale)

Se `infrastructure/test/` ha già pattern snapshot per `lambda-api.ts`, mirror it. Aggiungere assertion che il sintetizzato include:
- `NODE_EXTRA_CA_CERTS=/var/task/supabase-ca.crt` in `environment`
- Un commandHook che referenzia `supabase-ca.crt`

Se il pattern non esiste già: skip. Non vale aprire un nuovo set di test infra solo per questa PR.

### 7.2 Bundle integrity check (post-bundle)

Aggiungere fail-fast nel commandHook (script dedicato `infrastructure/scripts/copy-runtime-assets.cjs`):

```js
const fs = require('fs');
const path = require('path');

const src = path.resolve(__dirname, '..', 'assets', 'supabase-ca.crt');
const dest = path.join(process.argv[2], 'supabase-ca.crt');

if (!fs.existsSync(src)) {
  console.error(`[copy-runtime-assets] FATAL: ${src} not found`);
  process.exit(1);
}
fs.copyFileSync(src, dest);

const stat = fs.statSync(dest);
if (stat.size === 0) {
  console.error(`[copy-runtime-assets] FATAL: ${dest} is empty after copy`);
  process.exit(1);
}
```

Previene un asset silently dropped da future refactor del commandHook chain.

### 7.3 Integration test (no-op)

Test esistenti `packages/api/tests/integration/**` e `packages/database/tests/integration/**` usano Testcontainers Postgres con cert self-signed → continuano a funzionare con `sslmode=no-verify` o senza opzione SSL (default Testcontainers). Non accoppiare i test al cert prod — se serve testare TLS verification verso un Postgres con cert custom, è uno scenario futuro fuori da questo scope.

### 7.4 Smoke manuale post-deploy

Documentato in PR description come checklist:
- [ ] Step 1 deploy Lambda → `/health` 200
- [ ] Step 3 rotate secret → re-test `/health` 200
- [ ] Step 5 `/v1/users/me` con bearer → 200
- [ ] CloudWatch logs Lambda: nessun errore TLS

## 8. Acceptance criteria

- [ ] `infrastructure/assets/supabase-ca.crt` committato (PEM ~2 KB).
- [ ] `infrastructure/lib/constructs/lambda-api.ts` aggiunge `NODE_EXTRA_CA_CERTS` a `environment` e copy step a `commandHooks.afterBundling`.
- [ ] `infrastructure/scripts/copy-runtime-assets.cjs` esiste e fail-fasta su sorgente mancante / file vuoto.
- [ ] `packages/api/.env.example` e `packages/database/.env.example` documentano `NODE_EXTRA_CA_CERTS` per dev locale (commented-out di default).
- [ ] `infrastructure/README.md` aggiornato con sezione "TLS verification rotation runbook" che ricalca §4 di questo doc.
- [ ] Post-merge: deploy Lambda eseguito, `/health` 200 con secret intatto.
- [ ] Post-rotate: secret aggiornato a `sslmode=verify-full`, Lambda forced cold start, `/health` 200 e `/v1/users/me` 200.
- [ ] CloudWatch logs verificati: nessun TLS error.
- [ ] `project_tech_debt.md` aggiornato → voce TLS marcata `[resolved 2026-04-29, PR #XX]`.

## 9. Open questions / decisioni differite

- **`sslmode=verify-full` vs `verify-ca` come default finale**: si parte con `verify-full` allo Step 3, fallback a `verify-ca` se hostname mismatch. La decisione vincolante si prende live al deploy. Documentare l'esito nel commit message della rotation.
- **CA cert rotation tracking**: aggiungere un `infrastructure/assets/SUPABASE_CA_NOTES.md` con expiry date + URL sorgente del cert? Decidere durante il plan write — utile per future audit, costo basso (1 file da 10 righe).
- **CDK snapshot test**: aprire o no? Dipende se il pattern esiste già in `infrastructure/test/`. Da rilevare in plan mode.
