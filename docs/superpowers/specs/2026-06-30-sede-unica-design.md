# Design — Rimozione Sedi (officina = sede unica)

**Data:** 2026-06-30
**Tipo:** Large slice, cross-layer (schema migration distruttiva + API + web + admin-web + docs)
**Branch:** `feat/sede-unica`
**Decisione strutturale:** opzione B — assorbire l'indirizzo nel `Tenant`, **eliminare la tabella `locations`**.

## 1. Obiettivo e motivazione

GarageOS è pensato per piccole officine meccaniche italiane, che hanno **una sola sede fisica**. La macchina multi-sede attualmente spedita (CRUD sedi, flag `is_primary`, filtro cross-sede, assegnazione meccanico→sede, visibilità per-sede) è complessità inutilizzata che aggiunge attrito UX (es. il campo "Sede *" obbligatorio all'invito di un meccanico, il selettore sede in TopBar).

Questa slice rimuove il concetto di sede multipla. L'officina diventa un'entità unica con **un solo indirizzo, portato dal `Tenant`**. La tabella `locations` e tutte le FK `location_id` vengono eliminate.

**Fuori scope:** qualsiasi feature multi-sede futura (se mai servisse a un cliente enterprise, sarà una nuova slice con un modello dedicato — non si conserva nulla "per dopo", YAGNI).

## 2. Stato attuale (footprint da rimuovere)

- **Schema:** `Location` (`@@map("locations")`) con indirizzo NOT NULL, `is_primary`, `status LocationStatus`, soft-delete. FK `location_id`:
  - `interventions.location_id` — **NOT NULL, onDelete: Restrict**
  - `deadlines.location_id` — **NOT NULL, onDelete: Restrict**
  - `users.location_id` — nullable, SetNull
  - `access_logs.location_id` — nullable, SetNull
  - `invitations.location_id` — nullable, colonna semplice (nessuna relazione)
- **RLS:** `locations_read FOR SELECT USING(true)` (permissiva, per timeline cross-tenant) + `locations_write` tenant-scoped. Indice unico parziale `uq_locations_tenant_primary` (BR-201).
- **API:** CRUD sedi (`tenants-locations-write.ts`, `tenants-locations-list.ts`), `lib/location-filter.ts` (BR-205), stamping `location_id` su interventi/scadenze, assegnazione meccanico→sede (BR-204) in `update-user.ts` / `users-invitations-create.ts` / `admin-tenant-users*.ts` / `invitation-creation.ts` / `invitations-public-accept.ts`, scrittura `custom:location_id` in `cognito.ts`, parsing in `middleware/tenant-context.ts`.
- **Web officine:** tab "Sedi" (`LocationManagement`, `LocationFormDialog`, `queries/locations`, `validators/location`), feature `location-filter/` (context + `LocationSelector` in TopBar + hook), select "Sede" in `InviteUserDialog`/`EditUserDialog`/`ReactivateSection`.
- **admin-web:** `locationId` in `tenant-detail-types.ts` + UI utenti.
- **Docs:** BR-200/201/204/205 in APPENDICE_F; error code `location.*` in APPENDICE_G; F-OFF-003 / F-OFF-503.
- **Scripts:** `rebuild-tenants.mjs` crea una `locations` row "Sede principale" e setta `users.location_id`.

**Fatto chiave:** il `Tenant` **ha già** `addressLine`, `city`, `province`, `postalCode`, `phone`, `email` (tutti nullable) e `PATCH /v1/tenants/me` li modifica già (tab "Officina"). L'indirizzo della Location era duplicato. **Non servono nuove colonne indirizzo sul Tenant.**

**Verificato:** `Location.latitude/longitude` non sono letti da nessun codice app (solo schema + migration init) → droppabili senza conseguenze. `country`/`name` ridondanti (prodotto IT-only; `businessName` copre il nome).

## 3. Modello dati finale

- **`Tenant`:** invariato (l'indirizzo esistente diventa l'unica fonte di verità).
- **Colonne droppate:** `location_id` da `interventions`, `deadlines`, `users`, `access_logs`, `invitations`.
- **Droppati:** tabella `locations`, enum `LocationStatus`, indice `uq_locations_tenant_primary`, policy RLS `locations_read` / `locations_write`, trigger `updated_at` su `locations`.

### Migration fasata — 1 PR, 2 file + runbook operatore (expand → migrate → contract)

Le migration sono **operator-driven** (eseguite a mano con `DIRECT_URL`, non da `deploy.yml`). Phasing per evitare che container Lambda warm col vecchio codice scrivano su `location_id` durante il rollover.

**Migration A — expand** (`<ts>_sede_unica_expand`):
1. Backfill: per ogni tenant, copia l'indirizzo dalla sua location attiva primaria nei campi `tenants.*` **solo dove il campo tenant è NULL** (non sovrascrivere un indirizzo già inserito dall'officina):
   ```sql
   UPDATE tenants t SET
     address_line = COALESCE(t.address_line, l.address_line),
     city         = COALESCE(t.city, l.city),
     province     = COALESCE(t.province, l.province),
     postal_code  = COALESCE(t.postal_code, l.postal_code),
     phone        = COALESCE(t.phone, l.phone),
     email        = t.email  -- email tenant è NOT NULL, mai sovrascritta
   FROM locations l
   WHERE l.tenant_id = t.id
     AND l.deleted_at IS NULL
     AND l.is_primary = true
     AND l.status = 'active';
   ```
   (Robustezza: se un tenant non avesse una primary attiva, ripiego su qualsiasi location non cancellata — da gestire con una seconda UPDATE fallback nella migration.)
2. `ALTER TABLE interventions ALTER COLUMN location_id DROP NOT NULL;`
3. `ALTER TABLE deadlines ALTER COLUMN location_id DROP NOT NULL;`

**→ deploy codice (sezione 4/5) → smoke prod.**

**Migration B — contract** (`<ts>_sede_unica_contract`):
1. `ALTER TABLE` ... `DROP COLUMN location_id` su `interventions`, `deadlines`, `users`, `access_logs`, `invitations`.
2. `DROP TABLE locations CASCADE;` (rimuove FK residue, indici, policy RLS, trigger).
3. `DROP TYPE "LocationStatus";`

**Runbook operatore** (in APPENDICE_C, mirror dei precedenti operator-driven): run A → `cdk`/app deploy del codice → smoke → run B. Backup/snapshot DB prima di B (drop distruttivo, dati prod minimi ma irreversibile).

> ⚠️ Regola CLAUDE.md #8 (drop columns/tables) — approvata esplicitamente dall'utente per questa slice (2026-06-30).

## 4. API (`packages/api/src`)

- **Rimossi:** `routes/v1/tenants-locations-write.ts`, `routes/v1/tenants-locations-list.ts`, `lib/location-filter.ts` (+ relativa registrazione route).
- **Sfilato `locationId`:**
  - `lib/user-management/update-user.ts` — rimossa validazione/default/audit `locationId` e il default-meccanico→primary (BR-204).
  - `routes/v1/users-invitations-create.ts`, `routes/v1/admin-tenant-users.ts`, `routes/v1/admin-tenant-users-invitations.ts`, `routes/v1/users-admin-update.ts`, `routes/v1/users-admin-reactivate.ts` — niente più `locationId` nel body né default-meccanico.
  - `lib/invitation-creation.ts`, `routes/v1/invitations-public-accept.ts` — niente `locationId` portato sull'utente creato.
  - `routes/v1/interventions.ts`, `interventions-update.ts`, `interventions-cancel.ts`, `interventions-dispute-response.ts` — non timbrano/scopano più per `location_id`. **Scoping mechanic per-sede rimosso** (vedi §6).
  - `routes/v1/deadlines-create.ts`, `deadlines-complete.ts`, `lib/deadlines/recurrence.ts` — niente `location_id`.
  - `routes/v1/interventions-recent.ts`, `deadlines-list-tenant.ts`, `disputes-open.ts` — rimosso `resolveLocationFilter` e il param `location_id`; le query ritornano tutti i record del tenant.
  - `lib/access-log.ts` — niente `locationId`.
  - DTO `lib/dtos/user-me.ts`, `user-admin.ts`, `invitation.ts` — rimosso campo `locationId`.
- `routes/v1/admin-tenants-create.ts` — **non crea più la "Sede principale"**; crea solo Tenant (+ Invitation super_admin). Indirizzo tenant resta null finché l'officina non lo compila (consistente con lo stato attuale placeholder).
- `middleware/tenant-context.ts` — non legge più `custom:location_id`; rimosso `request.locationId`.
- `lib/cognito.ts` — non scrive/azzera più `custom:location_id`.
- `routes/v1/tenants-update.ts` e DTO `tenant-me` — **invariati** (indirizzo già editabile dal tab Officina).

## 5. Web

**officine (`packages/web/src`):**
- Rimossi: `pages/LocationManagement.tsx`, `components/locations/LocationFormDialog.tsx`, `queries/locations.ts`, `lib/validators/location.ts`, **intera** `location-filter/` (context, `LocationSelector`, hook, tipi).
- `pages/Settings.tsx` — rimosso tab "Sedi" e import relativi.
- `components/layout/TopBar.tsx` / `AppLayout.tsx` — rimosso `LocationSelector` e il provider del filtro.
- `components/users/InviteUserDialog.tsx`, `EditUserDialog.tsx`, `ReactivateSection.tsx` — rimosso il select "Sede" (meccanico non richiede più sede).
- Query `disputesOpen.ts`, `deadlinesList.ts`, `deadlinesUpcoming.ts`, `interventionsRecent.ts` — rimosso il param `location_id`.
- **Modifica indirizzo officina: resta nel `TenantForm` esistente (tab "Officina").** Nessuna nuova schermata.

**admin-web (`packages/admin-web/src`):**
- `lib/tenant-detail-types.ts` — rimosso `locationId` dal tipo utente.
- UI `TenantDetail` — rimosso ogni riferimento a sede nella tabella utenti.

## 6. Business rules, visibilità, error codes

- **BR-200 / BR-201 / BR-204 / BR-205:** marcate **superseded (sede-unica, 2026-06-30)** in APPENDICE_F (non cancellate dalla storia, ma annotate come non più in vigore).
- **Visibilità (rilassamento BR-205):** tutti gli utenti dell'officina (super_admin e meccanico) vedono **tutti** gli interventi/scadenze del tenant. Con sede unica è semanticamente equivalente al comportamento precedente. **Documentato come cambiamento intenzionale.** Il tenant isolation (RLS per `tenant_id`) resta intatto — nessun leak cross-tenant.
- **Error code rimossi** da APPENDICE_G (famiglia `location.*`): `location.cannot_delete_primary`, `location.cannot_unset_primary`, `location.has_active_users`, `user.location_required_for_mechanic`, `user.location_invalid`, `location.not_found` (verificare i nomi esatti in fase di plan via grep). **Nessun nuovo error code.**
- **Spec obsolete:** F-OFF-003 (location CRUD) e F-OFF-503 (location filter) marcate superseded; APPENDICE_A rimuove gli endpoint `/v1/tenants/me/locations`.
- **APPENDICE_B:** schema aggiornato (Location rimossa, `location_id` rimossi).

## 7. Cognito

- Stop scrittura/lettura `custom:location_id`. L'attributo nel pool officine resta definito (inerte) — **nessuna migrazione pool** (gli attributi custom Cognito non sono rimovibili e l'attributo non letto è innocuo).

## 8. Scripts / seed

- `scripts/rebuild-tenants.mjs` — non crea più la `locations` row né setta `users.location_id`; setta l'indirizzo sul Tenant.

## 9. Testing

Slice large → **spec formale + subagent-driven** (questo doc + plan + ledger `.superpowers/sdd/progress.md`).

- **Tier-1 (mandatori):**
  - **Migration backfill:** integration test che, partendo da tenant con indirizzo NULL + location con indirizzo, verifica il backfill corretto e il non-sovrascrittura quando il tenant ha già un indirizzo.
  - **RLS post-drop:** verificare che `locations` non esista più e che le query interventi/scadenze restino tenant-isolate.
  - **Route contract:** create intervento/scadenza **senza** `location_id`; status code + RFC 7807 invariati per il resto.
  - **Visibilità:** un meccanico vede ora tutti gli interventi del tenant (test che asserisce il nuovo comportamento, sostituendo i vecchi test BR-205).
  - **Tenant isolation negativo:** un altro tenant non vede gli interventi (invariato).
- **Cancellazioni:** la maggior parte del diff test è **rimozione** dei test delle feature eliminate (location CRUD, location filter, BR-204 default, mechanic location assignment).
- **Tier-2 (web):** smoke runbook + 2-3 test su `TenantForm` (l'indirizzo si salva) e assenza del tab Sedi.

## 10. Processo, review, smoke, PR size

- **Esecuzione subagent-driven** (plan da `docs/superpowers/PLAN_TEMPLATE.md`, pre-flight grep checklist obbligatoria). Per-task review solo sui task a rischio (migration, security/visibilità).
- **Final whole-branch review:** `/code-review high` minimo; **valutare `/code-review ultra`** data la migration distruttiva e l'ampiezza cross-layer.
- **Smoke prod obbligatorio** (UI officine: niente tab Sedi, indirizzo da tab Officina, invito meccanico senza sede; + esecuzione runbook migration A→deploy→B con verifica `/health` e dati).
- **PR size:** grande ma in larga parte **deletion**. Target 1 PR; se supera l'hard-limit 1500 LOC → **size-exception** da approvare con l'utente (come Slice 2/3), oppure split expand-PR / contract-PR.
- **Local gate:** `pnpm -r typecheck` pre-push; resto su CI.

## 11. Rischi e mitigazioni

- **Drop distruttivo irreversibile** → snapshot DB prima della migration B; dati prod minimi (2 tenant).
- **FK Restrict su interventi/scadenze** → gestite dal phasing (DROP NOT NULL in A, DROP COLUMN in B).
- **Container warm col vecchio codice** → mitigato dal phasing expand→migrate→contract.
- **Cascade test/route** (drift semantico tipo BR-205→visibilità) → pre-flight grep dei callsite e enumerazione cascade nel plan (lezione PR #115/#116).
- **Error code drift** → grep APPENDICE_G dei codici `location.*` effettivi prima di rimuoverli, per non lasciare riferimenti morti.
