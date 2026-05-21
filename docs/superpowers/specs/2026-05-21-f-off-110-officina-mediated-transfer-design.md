# F-OFF-110 — Trasferimento proprietà in officina (officina-mediated)

**Status:** design approved (brainstorming output)
**Author:** Claude (Opus 4.7) + Michele Matula
**Date:** 2026-05-21
**Spec ID:** F-OFF-110
**New BR:** BR-049

## Context

Vehicle transfer è documentato nello spec come feature mobile customer-side (F-CLI-401/402/403/404/405, BR-043 happy path + BR-044 senza cedente). Questo flow richiede:
- Doppia conferma cedente↔cessionario via app
- Codice/link transfer 7 giorni expiry
- Notifiche cross-customer

Il flow mobile è **parked** finché F-CLI-001 customer signup non si sblocca (AWS T&S/SES clearance, vedi `feedback_ses_prod_exit_gated_by_t_and_s`).

Questa slice introduce una **variante officina-mediated**: l'officina assiste il cliente cedente fisicamente in negozio durante il trasferimento. Presenza fisica + libretto = proof sostitutivo della doppia conferma remota. Single-step atomic swap, senza stati intermedi.

## Goals

1. Permettere all'officina di trasferire la proprietà di un veicolo certificato da un cliente esistente (cedente) a un nuovo proprietario (cessionario) in una singola operazione transazionale.
2. Riusare schema DB esistente (`VehicleTransfer`, `VehicleOwnership`, `OwnershipTransferReason`) — nessuna migration data-shape.
3. Preservare privacy BR-045: cedente non più visibile al cessionario; cessionario non vede private interventions del cedente.
4. Audit trail completo (VehicleTransfer row con `status='completed'`, AccessLog row).
5. Pilot-usable subito: feature funziona nel pilot Giuseppe senza dipendere da mobile/SES.

## Non-goals

- Mobile customer flow F-CLI-401/402/403/404/405 (separate slice, parked)
- OCR libretto / validazione automatica documento (BR-044 specifico mobile claim_without_seller)
- Workflow multi-step (BR-043 esiste per mobile remote-parties)
- Reversal/undo del transfer (errors corretti con transfer inverso)
- Cessionario invitation email all'app GarageOS (usa F-OFF-205 separatamente)
- Co-intestazione / più proprietari (BR-040 eccezione v2)
- PDF "certificato di trasferimento"
- Bulk transfer
- Email notification cessionario (BR-045 silenziosa, cessionario è in officina)

## Feature ID & Business Rule

### New feature: F-OFF-110

Inserito in `docs/GarageOS-Specifiche.md` §3 features officina vehicles range (dopo F-OFF-109):

> | F-OFF-110 | Trasferimento proprietà in officina | L'officina trasferisce la proprietà di un veicolo certificato da un cliente esistente a un nuovo proprietario, in single-step atomic swap. Richiede presenza fisica cedente + verifica libretto. Variante officina-mediated del passaggio proprietà (vedi BR-049) | 🟢 MUST |

### New business rule: BR-049

Inserito in `docs/APPENDICE_F_BUSINESS_LOGIC.md` §3 dopo BR-048:

> ### BR-049 — Passaggio di proprietà officina-mediated (single-step)
>
> Variante officina-mediated del passaggio di proprietà: il cedente è fisicamente presente in officina, l'officina verifica il libretto di circolazione e identità delle parti, ed esegue il transfer in **una singola operazione atomica** senza la doppia conferma di BR-043.
>
> **Razionale:** la presenza fisica + verifica documentale dell'officina sostituiscono il consenso remoto via app del flusso BR-043. Utile per clienti non-tech-savvy o per officine che gestiscono compravendite usato.
>
> **Precondizioni:**
> - Veicolo deve essere in stato `certified` (BR-046)
> - Veicolo deve avere `vehicle_ownership` attiva (`ended_at IS NULL`)
> - Non deve esistere un `VehicleTransfer` attivo per il veicolo (BR-047)
> - Cessionario ≠ cedente attuale
>
> **Effetti atomici** (singola transazione SQL):
> 1. `vehicle_ownerships` corrente: `ended_at = NOW()`, popola `transfer_reason` + `transfer_notes`
> 2. Nuova `vehicle_ownerships` row: `customer_id = cessionario.id`, `started_at = NOW()`, stessi `transfer_reason` + `transfer_notes`
> 3. `vehicle_transfers` row: `method = 'officina_mediated'`, `status = 'completed'`, `completed_at = NOW()`, `from_customer_id` + `to_customer_id` popolati
> 4. `customer_tenant_relations` per cessionario↔tenant garantita (UPSERT)
> 5. Se cessionario nuovo: `customers` row creata
> 6. `access_logs` row: `action = 'ownership_transfer'`
>
> **Cross-ref:** BR-043 (mobile remote-parties variant), BR-045 (cosa trasferisce / cosa no), BR-046 (no pending), BR-047 (no concurrent active transfers).
>
> Cross-ref aggiunta in BR-043: "Per la variante officina-mediated single-step vedi BR-049."

## Architecture

### Two-PR split

- **PR-1 (~1100-1300 LOC)**: backend (route + transazione + Zod + tests) + Web UI dialog (search/create cessionario + reason + notes + confirm) + docs updates + migration enum extensions. Vedi sezione "Files touched PR-1" per breakdown dettagliato.
- **PR-2 (~400-600 LOC)**: S3 libretto document upload (presigned URL pattern) + email notification cedente + push notification cedente (best-effort) + relative IAM/notification enum extensions.

### Package boundaries

| Package | Role |
|---|---|
| `@garageos/database` | Schema + migration enum extensions + factory + integration tests BR-049 |
| `@garageos/api` | Route + transaction lib + Zod schemas + unit + integration tests |
| `@garageos/web` | OwnershipTransferDialog + hook + component tests + wire in VehicleDetail |
| `docs/` | F-OFF-110, BR-049, API endpoint, error codes, test matrix |

## Data model

**Nessuna migration data-shape**. Schema esistente sufficiente:

- `VehicleOwnership` (existing): id, vehicleId, customerId, startedAt, endedAt, transferReason, transferNotes, createdAt
- `VehicleTransfer` (existing): id, vehicleId, fromCustomerId, toCustomerId, transferCode, invitedEmail, method, status, documentUrl, expiresAt, completedAt, rejectedReason
- `OwnershipTransferReason` enum (existing): purchase, inheritance, company_assignment, other
- `TransferStatus` enum (existing): pending_recipient, pending_seller_confirmation, pending_validation, completed, rejected, expired

### Migration in PR-1 (enum extensions only)

File: `packages/database/prisma/migrations/<timestamp>_officina_mediated_transfer/migration.sql`

```sql
ALTER TYPE "TransferMethod" ADD VALUE 'officina_mediated';
ALTER TYPE "AccessLogAction" ADD VALUE 'ownership_transfer';
```

Schema Prisma aggiornato:
```prisma
enum TransferMethod {
  initiated_by_seller
  claim_without_seller
  officina_mediated   // BR-049
}

enum AccessLogAction {
  view
  create
  update
  search_match
  cancel
  respond
  ownership_transfer  // BR-049
}
```

Both additive, no table rewrite.

## API contract

### `POST /v1/vehicles/:id/ownership-transfer`

**Auth**: Cognito JWT officina pool. Role `super_admin` o `mechanic`. Tenant scope: vehicle deve appartenere al tenant del caller (RLS-as-404).

**Path param**: `id` = vehicle UUID.

**Request body** (Zod discriminated union):

```ts
{
  recipient:
    | { kind: 'existing'; customerId: string /* uuid */ }
    | {
        kind: 'new';
        firstName: string;
        lastName: string;
        email: string;
        phone?: string | null;
        codiceFiscale?: string | null;
        isBusiness?: boolean;
        businessName?: string | null;
        vatNumber?: string | null;
      };
  reason: 'purchase' | 'inheritance' | 'company_assignment' | 'other';
  notes?: string | null;  // max 1000 char
}
```

**Response 200**:

```ts
{
  vehicle: { /* vehicleDetailSelect shape */ },
  ownership: { id, customerId, startedAt },
  transfer: { id, status: 'completed', completedAt, reason, notes }
}
```

### Errors (RFC 7807, `businessError(code, status, detail)` helper)

| Status | Code | Guard |
|---|---|---|
| 400 | `validation_error` | Zod parse fail |
| 401 | `auth.token_*` | gateway middleware |
| 403 | `vehicle.transfer.role_denied` | non super_admin/mechanic |
| 404 | `vehicle.not_found` | vehicle id non visibile al tenant (RLS-as-404, `findFirst({id,tenantId})` + null check) |
| 422 | `vehicle.transfer.pending_not_transferable` | BR-046 vehicle.status=pending |
| 422 | `vehicle.transfer.archived` | vehicle.status=archived |
| 422 | `vehicle.transfer.no_active_ownership` | vehicle senza ownership attiva (orphan) |
| 409 | `vehicle.transfer.active_transfer_exists` | BR-047 |
| 409 | `vehicle.transfer.same_owner` | cessionario === current owner |
| 422 | `vehicle.transfer.recipient_not_found` | `kind=existing` customerId non esistente |
| 409 | `customer.email_conflict` | `kind=new` email race condition (P2002 + refetch pattern PR #15) |

## Transaction flow

`prisma.$transaction(async tx => {...})` con `withContext({ tenantId, role: 'admin' })` (RLS write):

```
1. SELECT vehicle WHERE id=:vehicleId AND tenant_id=:tenantId AND status='certified'
   FOR UPDATE
   → 404 / 422 pending / 422 archived

2. SELECT ownership WHERE vehicle_id=:vehicleId AND ended_at IS NULL
   FOR UPDATE
   → 422 no_active_ownership
   → fromCustomerId = current.customerId

3. SELECT active transfer WHERE vehicle_id=:vehicleId AND status IN
     ('pending_recipient','pending_seller_confirmation','pending_validation')
   → 409 active_transfer_exists

4. Resolve recipient (toCustomer):
   - kind='existing':
       SELECT customer WHERE id=:customerId
       → 422 recipient_not_found
       Ensure customer_tenant_relation (UPSERT)
   - kind='new':
       Try-find: SELECT customer WHERE email=:email (global, cross-tenant)
       If found: reuse, ensure relation
       Else: INSERT customer (P2002 catch → refetch by email)
       Ensure customer_tenant_relation
   → 409 same_owner if toCustomerId === fromCustomerId

5. UPDATE vehicle_ownerships SET ended_at=NOW(),
     transfer_reason=:reason, transfer_notes=:notes
     WHERE id=current.id

6. INSERT vehicle_ownerships (vehicle_id, customer_id=toCustomerId,
     started_at=NOW(), transfer_reason=:reason, transfer_notes=:notes)

7. INSERT vehicle_transfers (vehicle_id, from_customer_id, to_customer_id,
     method='officina_mediated', status='completed',
     expires_at=NOW(), completed_at=NOW())

8. INSERT access_logs (action='ownership_transfer',
     resource_type='vehicle', resource_id=:vehicleId,
     tenant_id=:tenantId, user_id=:caller)
```

### Lock ordering (deadlock prevention)

Sempre nello stesso ordine: `vehicles` → `vehicle_ownerships` → `vehicle_transfers` → `customers` → `customer_tenant_relations`. Coerente con FK + alpha. Memoria `feedback_code_review_lock_graph_analysis`.

### Concurrency

- Two officina users → secondo `FOR UPDATE` blocca; secondo trova ownership.ended_at≠null → 422 `no_active_ownership` o nuova active ownership → BR-047 unique blocca 409.
- Customer email conflict step 4: catch P2002 → refetch by email → re-evaluate.

### RLS implications

- Tutte le write in `withContext({ tenantId, role: 'admin' })` (NOT empty context, memoria `feedback_withcontext_empty_blocks_rls_writes`).
- `customers` write: `role: 'admin'` bypassa cross-tenant filter su SELECT-only RLS (memoria `project_rls_split_pattern`).

### BR-045 privacy verification (no new code required)

- `vehicleOwnershipSelect` (`lib/vehicle-shared.ts:12`) filtra `endedAt: null` → query corrente sul veicolo ritorna solo ownership attiva. Cedente PII non emerge.
- `PrivateIntervention` query scoped per `customerId` → cedente private interventions restano col cedente.
- Customer detail page veicoli via `vehicle_ownerships endedAt=null` → veicolo trasferito sparisce dalla lista del cedente. ✅

## Web UI

### Entry point

Button **Trasferisci proprietà** nella scheda veicolo (`packages/web/src/features/vehicles/VehicleDetail.tsx` — path da verificare in implementation). Visibile solo se `vehicle.status === 'certified'` && c'è active ownership. Disabled state con tooltip se condizioni non soddisfatte.

### Dialog wizard (shadcn Dialog + Stepper o Tabs)

**Step 1 — Cessionario**
- Search box debounced (300ms) → endpoint customer search
- Risultati: lista con nome + email, click selezione
- "Aggiungi nuovo cessionario" → inline form (Zod + react-hook-form):
  - `firstName` *, `lastName` *, `email` *
  - `phone`, `codiceFiscale` opzionali
  - Toggle `Cliente aziendale` → `businessName` * + `vatNumber` *
- Validation: CF regex, email format

**Step 2 — Motivo & note**
- Dropdown `Motivo trasferimento` * (required):
  - Vendita (`purchase`)
  - Eredità (`inheritance`)
  - Assegnazione aziendale (`company_assignment`)
  - Altro (`other`)
- Textarea `Note` opzionale (1000 char counter)

**Step 3 — Conferma**
- Riepilogo cessionario + reason + notes
- Warning box: "Confermando il trasferimento, il veicolo passerà al nuovo proprietario in modo permanente. Verifica di aver controllato il libretto di circolazione. Questa azione non può essere annullata."
- Button `Conferma trasferimento` (`destructive` variant)
- Submit → POST → success: toast "Trasferimento completato" + dialog close + `queryClient.invalidateQueries(['vehicles', id])` + refreshed detail
- Error: toast con messaggio + dialog stays open

### State

- `useState` per wizard step
- `react-hook-form` + `@hookform/resolvers/zod` per form
- `useMutation` per submit

### i18n

Tutte le stringhe IT attraverso sistema esistente, no hardcode.

## Testing strategy

### DB integration tests (`packages/database/tests/integration/br-049-officina-mediated-transfer.test.ts`)

1. Atomic ownership swap — verifica old.ended_at, new row, transfer row, completedAt
2. BR-040 partial unique satisfied post-transfer (count = 1)
3. BR-046 enforcement (app guard, pending blocks)
4. BR-047 still enforced (second active transfer 409)
5. OwnershipTransferReason enum persisted on both ownership rows
6. transferReason/transferNotes copied on both ownership rows
7. AccessLog row with `ownership_transfer` action
8. TransferMethod `officina_mediated` enum accepted

Memoria `feedback_db_check_constraint_only_ci`: grep CHECK constraints pre-merge per evitare insert defensive che violano constraint nascosti.

### API integration tests (`packages/api/tests/integration/vehicles-ownership-transfer.test.ts`)

**Happy paths:**
1. recipient.kind=existing valid → 200
2. recipient.kind=new email nuova → 200 + customer/relation created
3. recipient.kind=new email same-tenant match → riusa, no duplicate
4. recipient.kind=new email cross-tenant match → riusa, crea relation
5. Cessionario isBusiness=true → businessName + vatNumber persisted

**Guards:**
6. 400 Zod missing reason
7. 401 no auth
8. 403 customer pool JWT (wrong pool)
9. 404 vehicle from other tenant
10. 422 `pending_not_transferable`
11. 422 `archived`
12. 409 `same_owner`
13. 409 `active_transfer_exists` (seed pending)
14. 422 `recipient_not_found`
15. 422 `no_active_ownership`

**Privacy BR-045:**
16. Post-transfer GET `/v1/vehicles/:id` → no cedente trace in response
17. Post-transfer GET customer-vehicles cedente → vehicle assente

Memoria `feedback_integration_test_rate_limit_isolation`: unique remoteAddress per describe block.

### API unit tests (`packages/api/tests/unit/routes/v1/vehicles-ownership-transfer.test.ts`)

FakePrisma stub con `vehicleTransfer`, `vehicleOwnership`, `customer`, `customerTenantRelation`, `accessLog` groups (memoria `feedback_handler_change_breaks_unit_mock`).

- Branch logic recipient resolve
- Error mapping ai businessError codes
- Zod schema parse pass/fail per varianti recipient

### Web component tests (`packages/web/src/features/vehicles/__tests__/OwnershipTransferDialog.test.tsx`)

1. Render dialog step 1 search visible
2. Search → mock results → click row → step 2 enabled
3. "Aggiungi nuovo" → inline form → validation
4. Step 2 reason required
5. Step 3 confirm → mutation called with correct payload
6. Error response → toast + dialog stays
7. Success → toast + close + invalidate

Memorie:
- `feedback_radix_tabs_user_event_not_fire_event` — `userEvent.click` per Radix tabs/dropdown
- `feedback_local_env_blocks_test_validation` — jest moduleNameMapper React single instance

### BR coverage matrix

| BR | Test type | File |
|---|---|---|
| BR-040 | DB integration | br-049-officina-mediated-transfer |
| BR-045 | API integration | vehicles-ownership-transfer |
| BR-046 | API integration | vehicles-ownership-transfer |
| BR-047 | DB + API integration | existing br-047 + new file |
| BR-049 | DB + API + Web | tutti i 3 file |

### Local gate

Pre-push `pnpm -r typecheck` only (memoria `feedback_skip_local_integration_tests`). CI runs full integration.

## Doc updates in PR-1

- `docs/GarageOS-Specifiche.md`: F-OFF-110 riga in §3 features officina vehicles
- `docs/APPENDICE_F_BUSINESS_LOGIC.md`: BR-049 + cross-ref in BR-043
- `docs/APPENDICE_A_API.md`: endpoint POST /vehicles/:id/ownership-transfer
- `docs/APPENDICE_G_ERROR_CODES.md`: 6 nuovi domain codes (`vehicle.transfer.*` + `customer.email_conflict` se non esiste)
- `docs/APPENDICE_E_TESTING.md`: BR-049 nel matrix BR↔Test (§8)

## Files touched PR-1 (estimate)

| Area | File | LOC est |
|---|---|---|
| Schema | `packages/database/prisma/schema.prisma` | +5 |
| Migration | `<ts>_officina_mediated_transfer/migration.sql` | +10 |
| API route | `packages/api/src/routes/v1/vehicles-ownership-transfer.ts` | +200 |
| API lib | `packages/api/src/lib/ownership-transfer.ts` | +120 |
| API tests unit | `packages/api/tests/unit/routes/v1/vehicles-ownership-transfer.test.ts` | +120 |
| API tests integration | `packages/api/tests/integration/vehicles-ownership-transfer.test.ts` | +180 |
| DB tests integration | `packages/database/tests/integration/br-049-officina-mediated-transfer.test.ts` | +150 |
| Web feature | `OwnershipTransferDialog.tsx` + hook | +180 |
| Web tests | `OwnershipTransferDialog.test.tsx` | +120 |
| Web wire | button su VehicleDetail.tsx | +10 |
| Docs | 5 file | +60 |
| **Totale stimato** | | **~1100-1300** |

Stima totale realistica oltre i ~700 iniziali del brainstorm: con 8 DB tests + 17 API tests + 7 Web tests + 3-step wizard, il volume di test arriva da solo a ~570 LOC.

Mid-execution LOC checkpoint (memoria `feedback_mid_execution_loc_checkpoint`):
- Soft warn: 1000 LOC
- Stop-and-ask: 1300 LOC
- Hard limit: 1500 LOC

Se durante esecuzione il volume supera 1300 senza chiusura task, controller deve halt + ask per split (es. estrarre Web UI o DB tests in PR-1b).

## PR-2 scope (separate plan dopo merge PR-1)

### S3 libretto document upload

- Endpoint `POST /v1/vehicles/:id/ownership-transfer/document-upload-url` → presigned URL response
- Body of transfer endpoint accetta opzionale `documentS3Key`
- Salvataggio in `VehicleTransfer.documentUrl` (S3 key, not URL)
- Serializer presigned-15-min on read (memoria `feedback_avatar_url_serializer_pattern`)
- Constraint: max 10MB, formati JPG/PNG/PDF/HEIC
- Bucket: `garageos-attachments-{env}`, prefix `vehicle-transfers/<vehicleId>/<transferId>/`
- IAM verify (memoria `feedback_lambda_iam_admin_enable_user_gap`)

### Email + push notification cedente

- Trigger post-commit best-effort fire-and-forget
- SES template IT con plate, data, officina, BR-045 disclosure
- Push best-effort se `fromCustomer.cognitoSub != null`
- Rispetta `notification_preferences` per categoria `vehicle_ownership_change` (nuova chiave)
- Idempotent via notifications outbox table
- Migration enum `NotificationCategory += 'vehicle_ownership_change'`

## Open questions (non bloccanti)

1. Path exact UI VehicleDetail.tsx — verify in implementation
2. Lambda IAM S3 grant `garageos-attachments-*` esistente (verify in PR-2)
3. NotificationCategory enum schema corrente (verify in PR-2)

## Memory references applicable

- `feedback_middleware_throw_fastifyerror_not_reply_send` — businessError helper pattern
- `feedback_rls_split_changes_endpoint_semantics` — findFirst({id,tenantId}) + null check
- `feedback_withcontext_empty_blocks_rls_writes` — explicit role in withContext
- `feedback_code_review_lock_graph_analysis` — lock ordering for FOR UPDATE
- `feedback_db_check_constraint_only_ci` — grep CHECK pre-merge
- `feedback_integration_test_rate_limit_isolation` — unique remoteAddress
- `feedback_handler_change_breaks_unit_mock` — FakePrisma group coverage
- `feedback_radix_tabs_user_event_not_fire_event` — userEvent.click
- `feedback_mid_execution_loc_checkpoint` — LOC tracking mid-execution
- `feedback_pr_size_tracking` — git diff --stat checkpoint
- `feedback_lambda_iam_admin_enable_user_gap` — enumerate IAM grants (PR-2)
- `feedback_subagent_driven_review_loop` — 3-stage review pattern
- `feedback_avatar_url_serializer_pattern` — S3 key in DB, presigned on read (PR-2)
- `feedback_skip_local_integration_tests` — pre-push typecheck only
- `feedback_prisma_data_xor_defeats_excess_property` — explicit grep post-schema-rename
- `feedback_schema_rename_cascade_extends_to_production_code` — production cascade enumeration
- `project_rls_split_pattern` — admin role bypass cross-tenant
