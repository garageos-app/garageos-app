# PR4 — Contract migration DB (drop attachments + avatar_url + logo_url)

**Arco:** "Rimuovi upload + elimina S3" (design `docs/superpowers/specs/2026-07-01-remove-uploads-and-s3-design.md` §Blocco D).
**Ordine:** PR1 streaming (✅ #240) → PR2 rimozione upload (✅ #241) → PR3 infra/env/deps S3 (✅ #242) → **PR4 (questo)** → Operator step E (migration prod + delete bucket).

## Cosa

Contract migration finale: droppa gli oggetti DB ormai orfani dopo che PR1/PR2/PR3 hanno rimosso tutti i reader/writer. Nessun cambio comportamento runtime.

- `DROP TABLE attachments CASCADE` (rimuove FK dispute_id, indici `idx_attachments_*`, constraint `chk_attachment_size`+`chk_attachment_owner_consistent`, RLS `attachments_read/insert/update`).
- `DROP TYPE "AttachmentOwnerType"`.
- `ALTER TABLE users DROP COLUMN avatar_url`.
- `ALTER TABLE tenants DROP COLUMN logo_url`.

## Pre-flight (grep/typecheck)

- **Reader residui nel codice sorgente: 0** (solo un commento stale in `tenants.ts`, ripulito). I `generated/prisma/client/*` si rigenerano (gitignored, non tracciati).
- **Riferimenti esterni alla tabella `attachments`: 0** → `DROP TABLE ... CASCADE` pulisce tutto (FK/indici/constraint/RLS).
- **Test attivi che seedavano/leggevano gli oggetti** (rimossi): `helpers.ts::createAttachment`; `me-private-interventions.test.ts` test "DELETE does not cascade-delete attached files" + import; `interventions-pdf.test.ts` "Case 6 logo_url" + import `pgAdmin` orfano; `tenant.factory.ts` campo `logoUrl: null`.
- Le assertion negative `not.toHaveProperty('logoUrl')` in `tenants-me.test.ts`/`tenants.test.ts` RESTANO (asseriscono assenza nel DTO, ancora vere).
- `avatar_url`/`logo_url` = colonne nullable plain, ZERO index/constraint/policy dipendenti.
- Enum PG = `"AttachmentOwnerType"` (PascalCase quoted, verificato in init migration).

## Migration

`packages/database/prisma/migrations/20260702120000_drop_attachments_avatar_logo/migration.sql` — SQL puro, pattern `sede_unica_contract`. Portabile (no ROLE/DATABASE hardcoded). **Operator-driven con `DIRECT_URL`, NON in deploy.yml.**

Ordine: DROP COLUMN (users, tenants) → DROP TABLE attachments CASCADE → DROP TYPE (l'enum è usato solo dalla colonna owner_type, quindi va droppato dopo la tabella).

## Ordering safety (contract pattern)

Il merge auto-deploya l'app con un client Prisma che non conosce più questi oggetti. L'app deployata gira contro la prod DB che LI HA ANCORA (finché l'operator non runna la migration) → Prisma ignora le colonne extra → nessuna finestra rotta. Poi l'operator droppa. Sicuro perché PR1/PR2/PR3 hanno già rimosso ogni uso.

## Schema + doc

- `schema.prisma`: rimossi enum `AttachmentOwnerType`, `Tenant.logoUrl`, `User.avatarUrl`, relazione `InterventionDispute.attachments`, model `Attachment`. `prisma validate` + `generate` OK.
- APPENDICE_B: rimossi enum/colonne/model mirror; constraint + RLS SQL sostituiti con nota RIMOSSO; validator mirror `attachmentIds` via.

## Testing

- **Gate locale:** `pnpm -r typecheck` verde (client rigenerato; api+infra+database check full). Typecheck ha catturato 2 residui (import `pgAdmin` orfano, factory `logoUrl`) → fixati.
- **CI:** integration applica la migration su Testcontainers fresh (drop su DB che ha gli oggetti dalla init) → i test rimanenti non li referenziano più. CDK synth/lint/format/commitlint.
- Final gate: `/code-review high`.

## Operator step E (post-merge, TU con la mia guida)

1. **Run migration su prod** (conferma esplicita — drop di tabelle/colonne, CLAUDE.md#8): `.env` `DIRECT_URL` = Session pooler Supabase (IPv4), Node 22 via fnm, `NODE_TLS_REJECT_UNAUTHORIZED=0`, `pnpm --filter @garageos/database exec prisma migrate deploy`. Verifica: `to_regclass('public.attachments')` = NULL, enum droppato, colonne assenti.
2. Deploy CDK già avvenuto con PR3 (bucket orfano da RETAIN) — nessun nuovo deploy infra necessario.
3. **Svuota + elimina il bucket fisico** `garageos-production-attachments` (AWS CLI/console, conferma; file pilot persi = accettato). NON toccare il bucket di web-hosting.
