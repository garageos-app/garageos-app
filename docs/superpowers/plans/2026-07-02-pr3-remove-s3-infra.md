# PR3 — Rimozione infra / env / deps S3

**Arco:** "Rimuovi upload + elimina S3" (design `docs/superpowers/specs/2026-07-01-remove-uploads-and-s3-design.md` §Blocco C).
**Ordine:** PR1 streaming (✅ #240) → PR2 rimozione upload (✅ #241) → **PR3 (questo)** → PR4 contract migration DB → Operator step E (migration + deploy + delete bucket).

## Cosa

Rimuovere ogni traccia dell'infrastruttura S3 attachments dopo che PR1/PR2 hanno eliminato i produttori/consumatori (streaming diretto PDF/tag; rimozione feature upload). Nessun cambio comportamento runtime — il codice non usava più S3 dopo PR2. Il bucket fisico resta orfano (`RemovalPolicy.RETAIN`) fino allo step operator.

## Pre-flight (grep)

- `packages/api/src` → **0** import `@aws-sdk/client-s3`/`s3-request-presigner` dopo PR2 → deps rimovibili in sicurezza.
- `aws-sdk-client-mock` → usato broadly per Cognito/SES/Scheduler → **resta** (non è S3-specifico).
- `production.ts` → **nessuna** config bucket/CORS attachments (solo web/admin hosting, da NON toccare) → niente da fare lì.
- `S3_ATTACHMENTS_BUCKET` → schema `env.ts` + 5 test setup (`??=` placeholder) + wiring trigger Cognito in `main-stack.ts` (#217).
- Fake creds `AWS_ACCESS_KEY_ID/SECRET` → usate da ~20 test file (scheduler/SES/notifications), **non** solo dal presigner → mantenute; aggiornati solo i commenti che citavano il defunto `lib/s3.ts`.
- Doc vivi drifted: APPENDICE_A §2.14/2.15 (`tag_download_url` S3-presign), §2.13 prosa intervention-PDF (cache S3 + logo S3), APPENDICE_C §5.4, APPENDICE_E:781 (BR-180), infra README §F-Storage.
- APPENDICE_B (drop tabella/colonne) e `schema.prisma` = **PR4** (contract migration), fuori scope qui.

## Task

1. **API deps + env** — rimuovi `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` da `packages/api/package.json` (+ `pnpm install` lockfile); rimuovi `S3_ATTACHMENTS_BUCKET` da `env.ts`; togli dalla fixture `valid` + 2 test in `env.test.ts`; togli le righe `??=` nei 5 test setup; aggiorna i commenti stale su `lib/s3.ts`.
2. **Infra construct** — cancella `storage.ts`; da `lambda-api.ts` togli prop `attachmentsBucket`, le 2 policy S3 (GetObject/PutObject + ListBucket), l'env `S3_ATTACHMENTS_BUCKET`, l'import `s3`; da `main-stack.ts` togli import + istanza `StorageConstruct` + `addEnvironment('S3_ATTACHMENTS_BUCKET')` sul trigger + prop + `CfnOutput AttachmentsBucketName`; aggiorna commenti `web-hosting.ts` che citavano StorageConstruct.
3. **Infra test** — da `main-stack.test.ts` togli import/istanze/prop/asserzioni S3, il test trigger-env S3, il test grant S3, e porta `resourceCountIs('AWS::S3::Bucket')` a **0**; splitta `storage-waf.test.ts` → `waf.test.ts` (solo WAF).
4. **Docs** — APPENDICE_A §2.14/2.15 (tag → PDF binario streaming) + §2.13 prosa; APPENDICE_C changelog v1.5 + §5.4 rimossa; APPENDICE_E:781 (riga BR-180 via); infra README §F-Storage → nota RIMOSSO.

## Testing

- **Gate locale:** `pnpm -r typecheck` (api + infra check full non-incrementali → affidabili). ✅
- **Unit mirato:** `env.test.ts` (14/14 verde) valida lo schema senza `S3_ATTACHMENTS_BUCKET`.
- **CI (matrice completa in parallelo):** infra `test:unit` (`resourceCountIs` bucket=0, waf.test.ts), api `test:unit`/`test:integration`, CDK synth, commitlint. Infra test NON eseguiti localmente (esbuild ×3 freeza Windows — CI-only).
- Final gate: `/code-review high` sull'intero branch.

## Note per PR4 / Operator

- PR4: `DROP TABLE attachments` + enum `AttachmentOwnerType` + colonne `avatar_url`/`logo_url` + RLS/constraint/indici; `schema.prisma`; operator-driven con `DIRECT_URL`, conferma pre-deploy (CLAUDE.md#8).
- Operator step E: migration prod → deploy CDK (rimuove il construct) → svuota + elimina bucket fisico `garageos-production-attachments`.
- Drift doc residuo per PR4: APPENDICE_B:1107 commento `BR-180`.
