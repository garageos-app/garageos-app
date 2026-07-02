# Ridisegno tipi di intervento + checklist, config visibilità per-tenant, rimozione titolo

**Data:** 2026-07-02
**Tipo:** Slice grande cross-layer / arco multi-PR (7 PR)
**Autore:** Michele + Claude (brainstorming)

## What

Due modifiche strutturali coordinate al dominio "intervento", da rilasciare come un unico arco:

**A) Ridisegno tipi + checklist.** La registrazione/modifica di un intervento passa da un modello a **12 tipi granulari mono-selezione** a un modello a **3 tipi "coarse" + checklist multi-selezione**. Selezionato il tipo dalla dropdown, compare una checklist di voci (multi-selezione) legata a quel tipo. Il catalogo (tipi + voci) è **globale** e gestito **esclusivamente nell'admin console**. Ogni tenant riceve un catalogo filtrato tramite **esclusioni per-tenant gestite dall'admin** (l'officina non configura nulla).

**B) Rimozione del titolo.** Il concetto di "titolo" dell'intervento (`Intervention.title`) viene eliminato dall'intero sistema. L'intestazione dell'intervento diventa il **nome del tipo**.

## Why

Richiesta prodotto dell'owner (Michele, 2026-07-02, conversazione di brainstorming — questa è la fonte di design, non esiste un F-XXX-YYY precedente). Obiettivi:

- Registrazione più guidata e strutturata (checklist invece di testo libero + tipo iper-granulare).
- Dati interrogabili sulle lavorazioni effettivamente svolte.
- Controllo centralizzato del catalogo lato piattaforma, con personalizzazione della visibilità per officina senza dare all'officina strumenti di editing.
- Il titolo libero era ridondante e spesso duplicava il nome del tipo.

Nuove business rule allocate: **BR-300 … BR-308** (numeri verificati liberi contro `APPENDICE_F` — max attuale BR-298; da inserire in `APPENDICE_F` nel PR DB).

## Decisioni di design (fissate in brainstorming)

| # | Decisione |
|---|---|
| D1 | Le voci selezionate sono un **record strutturato** sull'intervento (non solo precompilazione descrizione). |
| D2 | Config visibilità per-tenant **solo admin**; l'officina è passiva (vede il catalogo effettivo). |
| D3 | Modello **opt-out**: nuovo tipo/voce **visibile di default a tutti i tenant**; la config memorizza solo le **esclusioni**. |
| D4 | **Checklist obbligatoria**: ≥1 voce selezionata per intervento. Descrizione libera **opzionale**. |
| D5 | I 12 tipi granulari attuali vengono **rimossi**; i dati intervento di test vengono **azzerati** (operator-driven, conferma esplicita — non in migration automatica). Si riparte con 3 tipi + checklist. |
| D6 | Il **suggerimento scadenza resta sul tipo** (invariato: `suggestsDeadline`, `defaultDeadlineMonths/Km`). Le voci checklist non portano scadenze. |
| D7 | Le voci selezionate sono mostrate su: **dettaglio intervento (web)**, **PDF**, **app mobile cliente + timeline**. |
| D8 | Storage selezioni: **tabella join + `label_snapshot`** (etichetta congelata al salvataggio). |
| D9 | **Titolo rimosso** interamente; intestazione = nome del tipo. `PrivateIntervention.customType` **intatto** (concetto diverso). |
| D10 | Voci checklist **globali-only** (nessun `tenantId`); `code` univoco **per tipo**; `sortOrder` numerico; niente drag-and-drop in v1. |

## Modello dati

### Tabelle riusate / modificate

**`intervention_types`** (esistente): ospita i **3 tipi coarse** (globali, `tenant_id = NULL`). I 12 tipi di sistema attuali vengono rimossi dal seed. Mantiene i campi scadenza.

Seed proposto (da confermare in review):

| code | nameIt | category | suggestsDeadline | months | km |
|---|---|---|---|---|---|
| `MECCANICO` | Intervento Meccanico | maintenance | true | 12 | 15000 |
| `GOMME` | Cambio Gomme | tires | true | 6 | null |
| `REVISIONE` | Revisione | inspection | true | 24 | null |

**`interventions`**: rimozione colonna **`title`** (contract step, con dati test azzerati). Nessun'altra modifica strutturale (la descrizione resta `TEXT`, ora opzionale a livello applicativo — vedi BR-300/BR-304 nota).

> Nota: `description` in `schema.prisma` è `String @db.Text` (NOT NULL). Con checklist obbligatoria + descrizione opzionale, l'app potrà salvare stringa vuota. Manteniamo la colonna NOT NULL con default `''` a livello applicativo (nessuna migration destruttiva sulla colonna description). La validazione "≥1 voce" garantisce contenuto.

### Tabelle nuove

**`intervention_checklist_items`** — catalogo voci, globali, legate a un tipo.
```
id                  uuid pk
intervention_type_id uuid fk -> intervention_types (onDelete Cascade)
code                varchar(50)
name_it             varchar(150)
sort_order          smallint default 0
active              boolean default true
created_at / updated_at
UNIQUE (intervention_type_id, code)   -- BR-307
INDEX (intervention_type_id)
```

**`tenant_intervention_type_exclusions`** — opt-out tipi (righe = tipi nascosti al tenant).
```
tenant_id            uuid fk -> tenants (onDelete Cascade)
intervention_type_id uuid fk -> intervention_types (onDelete Cascade)
created_at
PK (tenant_id, intervention_type_id)
```

**`tenant_checklist_item_exclusions`** — opt-out voci (righe = voci nascoste al tenant).
```
tenant_id         uuid fk -> tenants (onDelete Cascade)
checklist_item_id uuid fk -> intervention_checklist_items (onDelete Cascade)
created_at
PK (tenant_id, checklist_item_id)
```

**`intervention_checklist_selections`** — voci spuntate su un intervento, con snapshot.
```
id                 uuid pk
intervention_id    uuid fk -> interventions (onDelete Cascade)
checklist_item_id  uuid NULL fk -> intervention_checklist_items (onDelete SetNull)
label_snapshot     varchar(150) NOT NULL   -- BR-303
sort_order_snapshot smallint NULL
created_at
UNIQUE (intervention_id, checklist_item_id)
INDEX (intervention_id)
```
`checklist_item_id` è nullable + `onDelete SetNull`: se l'admin elimina una voce dal catalogo, le selezioni storiche sopravvivono con `label_snapshot` preservato (D8).

### RLS (livello design; specifiche finali nel plan del PR DB)

Seguire i pattern esistenti (`[[rls-split-pattern]]`, `intervention_types_isolation` permissivo in lettura):

- `intervention_checklist_items`: **SELECT permissivo** (`USING (true)`), coerente con `intervention_types`, per consentire risoluzione cross-tenant se necessaria. Nessuna policy INSERT/UPDATE/DELETE per il ruolo runtime: le scritture avvengono sul **path platform-admin** (come gli endpoint `admin-*` esistenti, es. `admin-tenants-create.ts`).
- `tenant_intervention_type_exclusions`, `tenant_checklist_item_exclusions`: **SELECT tenant-scoped** (`USING (tenant_id = current_tenant)`), scrittura sul path platform-admin.
- `intervention_checklist_selections`: **mirror della RLS di `interventions`** (SELECT permissivo per la timeline cliente cross-tenant, scrittura tenant-scoped). Le selezioni ereditano il confine di tenant dall'intervento padre.

Ogni nuova tabella richiede **negative test** RLS (isolamento tenant, admin-only write, opt-out read). Vedi `[[rls-intervention-types-permissive-read]]`.

## API surface

### Admin console (`/v1/admin/...`, auth `requireAuth → requirePlatformAdminsPool`, no `tenantContext`)

Catalogo globale:
- `GET /v1/admin/intervention-types` — lista tipi (incl. inattivi)
- `POST /v1/admin/intervention-types` — crea tipo
- `PATCH /v1/admin/intervention-types/:id` — modifica (nameIt, scadenze, active)
- `DELETE /v1/admin/intervention-types/:id` — elimina/disattiva
- `GET /v1/admin/intervention-types/:id/checklist-items` — voci del tipo
- `POST /v1/admin/intervention-types/:id/checklist-items` — crea voce
- `PATCH /v1/admin/checklist-items/:id` — modifica voce
- `DELETE /v1/admin/checklist-items/:id` — elimina voce

Config visibilità per-tenant:
- `GET /v1/admin/tenants/:tenantId/catalog-visibility` — catalogo con flag `visible` per tipo/voce (esclusioni applicate)
- `PUT /v1/admin/tenants/:tenantId/catalog-visibility` — imposta l'insieme di esclusioni (tipi + voci) per il tenant (replace atomico)

### Officina web (`/v1/...`, auth invariata)

- `GET /v1/intervention-types` — **modificato**: restituisce i tipi **visibili** al tenant (esclusi quelli senza almeno una voce visibile — BR-305), ciascuno con l'array delle **voci checklist visibili** (esclusioni applicate lato server). Retro-compatibilità: il campo `custom` esistente resta; si aggiunge `checklistItems: [{ id, code, nameIt, sortOrder }]`.
- `POST /v1/interventions` — **modificato**: accetta `checklistItemIds: string[]` (≥1, BR-300); rimuove `title`. Validazione BR-301/302; salva selezioni con `label_snapshot`.
- `PATCH /v1/interventions/:id` — **modificato**: accetta `checklistItemIds` (replace del set, ≥1); rimuove `title`. Le voci già presenti mantengono lo snapshot; le nuove voci prendono lo snapshot corrente (BR-303).

### Read (dettaglio / PDF / mobile / timeline)

Le rotte di lettura (`interventions-detail`, `interventions-pdf`, `me-interventions`, `customer-intervention-detail`, `vehicles-timeline`, `me-vehicles-export-pdf`) espongono `checklistItems: [{ label }]` **letto dallo snapshot** (nessun join sul catalogo globale) e **rimuovono `title`** dai DTO.

## Data flow & edge case

- **Opt-out**: catalogo effettivo del tenant = (tipi globali − esclusioni tipo) e per ciascuno (voci − esclusioni voce). Tutto ciò che non è escluso è visibile.
- **Tipo senza voci visibili** per un tenant (tutte escluse o tipo senza voci): il tipo **non è selezionabile** nel form → viene omesso da `GET /v1/intervention-types` (BR-305). Garantisce che il vincolo "≥1 voce" sia sempre soddisfacibile.
- **Snapshot** (D8/BR-303): rinomina/eliminazione admin di una voce non altera gli interventi già salvati.
- **Descrizione**: opzionale; se vuota, l'intervento è comunque valido perché ha ≥1 voce.
- **Cleanup dati test** (D5): step operator-driven documentato nel runbook del PR DB — `TRUNCATE` interventi + dipendenti (revisioni, dispute, selezioni, deadline collegate) e rimozione dei 12 tipi, con conferma esplicita dell'owner prima dell'esecuzione. **Non** incluso in una migration automatica.

## Business rules (nuove — da scrivere in `APPENDICE_F`)

| BR | Regola |
|---|---|
| BR-300 | **Checklist obbligatoria**: un intervento deve avere ≥1 voce checklist selezionata (create e edit). |
| BR-301 | **Appartenenza voce↔tipo**: ogni voce selezionata deve appartenere al tipo di intervento scelto. |
| BR-302 | **Visibilità/attività voce**: una voce selezionata non deve essere esclusa per il tenant e deve essere `active`. |
| BR-303 | **Snapshot etichetta**: la `label` della voce è congelata al salvataggio; l'edit ricalcola lo snapshot solo per le voci aggiunte. |
| BR-304 | **Opt-out**: un nuovo tipo/voce è visibile a tutti i tenant salvo esclusione esplicita. |
| BR-305 | **Selezionabilità tipo**: un tipo è offerto all'officina solo se ha ≥1 voce visibile per quel tenant. |
| BR-306 | **Governance catalogo**: il catalogo (tipi + voci + esclusioni) è scrivibile solo dal platform admin; l'officina ha sola lettura del catalogo effettivo. |
| BR-307 | **Unicità `code` voce**: `code` univoco per tipo. |
| BR-308 | **Titolo rimosso**: l'intervento non ha più un titolo; nessun input né persistenza. |

## Error codes (nuovi — da inserire in `APPENDICE_G`)

Officina:
- `intervention.creation.checklist_required` | 400 | BR-300 — nessuna voce selezionata
- `intervention.creation.checklist_item_invalid` | 422 | BR-301/302 — voce non appartiene al tipo, o esclusa, o inattiva

Admin:
- `admin.intervention_type.not_found` | 404
- `admin.intervention_type.code_conflict` | 409
- `admin.checklist_item.not_found` | 404
- `admin.checklist_item.code_conflict` | 409 — `code` duplicato nel tipo (BR-307)
- `admin.catalog_visibility.tenant_not_found` | 404
- `admin.catalog_visibility.invalid_ref` | 422 — id tipo/voce inesistente nell'insieme esclusioni

(Grep preventivo su `APPENDICE_G` prima di finalizzare — vedi `[[preflight-must-grep-appendice-g-codes]]`.)

## Decomposizione in PR

Un unico spec, plan per PR. La rimozione titolo (B) è **assorbita** nei PR che toccano gli stessi file, non isolata.

1. **PR-DB** — `chore(database)`: nuove tabelle + RLS + indici; rimozione colonna `title` (contract); seed 3 tipi + checklist; rimozione 12 tipi; aggiorna `APPENDICE_B`. Runbook cleanup dati test. Aggiorna `seed-data.ts` e i seed pilot.
2. **PR-ADMIN-CATALOG** — `feat(api,admin)`: endpoint admin CRUD tipi + voci; UI admin console "Catalogo interventi".
3. **PR-ADMIN-VISIBILITY** — `feat(api,admin)`: endpoint esclusioni per-tenant; UI admin "Visibilità per officina".
4. **PR-OFFICINA-API** — `feat(api)`: `GET /v1/intervention-types` con esclusioni + checklist; `POST`/`PATCH` interventions con `checklistItemIds` e rimozione `title`; validazioni BR-300/301/302; letture (detail) senza title + con selezioni.
5. **PR-WEB** — `feat(web)`: form (dropdown→checklist), edit dialog, pagina dettaglio; rimozione titolo da form/header/timeline web.
6. **PR-PDF** — `feat(api)`: voci checklist nel PDF; rimozione titolo dal renderer PDF.
7. **PR-MOBILE** — `feat(mobile)`: vista cliente (detail + timeline) con voci; rimozione titolo da types/timeline/detail mobile.

Dipendenze: PR-DB blocca tutti. PR-OFFICINA-API blocca PR-WEB/PR-PDF/PR-MOBILE. PR-ADMIN-* indipendenti da PR-OFFICINA (paralleli dopo PR-DB), ma la config esclusioni serve per testare a fondo BR-305 in PR-OFFICINA (mock/seed nel frattempo).

## Testing (two-tier, Tier 1 dove conta)

**Tier 1 (obbligatorio):**
- RLS/security nuove tabelle: isolamento tenant, admin-only write, opt-out read, negative test.
- Validazione create/edit: BR-300 (≥1 voce), BR-301 (appartenenza), BR-302 (visibile+attiva) con negative test; BR-305 (tipo senza voci non offerto).
- Snapshot BR-303: rinomina/eliminazione voce non altera interventi salvati.
- Contratti API: status + error code + envelope RFC7807 per tutti i nuovi endpoint.
- Admin: `code` conflict (BR-307), replace atomico esclusioni.

**Tier 2 (minimo, 2-3 test/schermo):**
- UI admin catalogo/visibilità: happy path, stato errore, logica condizionale.
- Form officina: happy path selezione checklist, errore "nessuna voce", cambio tipo resetta selezioni.
- Dettaglio/timeline/mobile: rendering elenco voci + assenza titolo.

**Smoke runbook** (obbligatorio, PR UI): flusso completo officina (seleziona tipo → checklist → salva → dettaglio → PDF), config admin (crea voce, escludi per tenant → sparisce nel form officina), mobile cliente vede le voci.

## Rischi / note

- **Drop colonna `title`**: destructive; consentito solo perché i dati sono di test e con conferma owner (D5). Pattern contract, non expand→contract completo (nessun consumatore rimane dopo i PR API/web/mobile/PDF).
- **`GET /v1/intervention-types` breaking**: la shape cambia (aggiunge `checklistItems`, i tipi diventano 3). I consumatori (web form) si aggiornano nello stesso arco. Nessun client esterno.
- **Ordine merge**: PR-DB deve essere in `main` prima degli altri per far girare gli integration test su schema aggiornato.
- **Deadline coarse** (D6): "Intervento Meccanico" avrà un unico default scadenza generico; accettato consapevolmente. Se in futuro serve granularità, si sposta la scadenza sulle voci (fuori scope).

## Riferimenti codice

- `packages/database/prisma/schema.prisma` (InterventionType L448, Intervention L472)
- `packages/database/src/seed-data.ts` (SYSTEM_INTERVENTION_TYPES)
- `packages/api/src/routes/v1/intervention-types.ts`
- `packages/api/src/routes/v1/interventions.ts`, `interventions-update.ts`, `interventions-detail.ts`, `interventions-pdf.ts`, `me-interventions.ts`, `vehicles-timeline.ts`, `customer-intervention-detail.ts`, `me-vehicles-export-pdf.ts`
- `packages/web/src/components/intervention-form/InterventionForm.tsx`, `EditInterventionDialog.tsx`, `intervention-detail/InterventionHeader.tsx`, `TimelineRow.tsx`, `pages/InterventionDetail.tsx`
- `packages/mobile/src/components/TimelineRow.tsx`, `src/lib/types/intervention.ts`
- `packages/api/src/routes/v1/admin-tenants-create.ts` (pattern auth/audit admin di riferimento)
