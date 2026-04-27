# PATCH /v1/vehicles/:id — Design (F-OFF-106)

**Status:** approved
**Date:** 2026-04-27
**Author:** Michele Matula (with Claude)
**PR target:** #15
**Feature:** F-OFF-106 (Modifica dati veicolo)
**Related BR:** BR-001, BR-002, BR-005, BR-007, BR-008, BR-022, BR-150, BR-151

## 1. Goal

Permettere a un'officina (Tenant User) di modificare i dati tecnici e identificativi della scheda di un veicolo che ha creato o certificato. È il "preludio" funzionale a `PATCH /v1/interventions/:id` (BR-062 wiki window) e copre il caso "errore manifesto" della spec F-OFF-106 (es. VIN trascritto male, plate sbagliata).

Sono **fuori scope** per questo PR:
- Modifica del `status` (gestita da endpoint dedicati: `POST /v1/vehicles/:id/certify` per `pending → certified`, futuro `POST /v1/vehicles/:id/archive` per `* → archived`).
- Modifica del `garageCode` (immutabile per BR-022).
- Modifica della proprietà / ownership (gestita da `POST /v1/transfers` — F-OFF-501).
- Storico delle modifiche con diff campi-by-campo (deferred — vedi sezione 7).
- Concurrency control con `If-Match` (deferred — vedi sezione 7).

## 2. API contract

```
PATCH /v1/vehicles/:id
Auth: requireAuth + requireOfficinaPool + tenantContext (Tenant User)

Path params:
  id: UUID

Body (Zod .strict — campi extra → 400 ZodError):
{
  vin?:                 string (17 chars, alphanumeric)  // BR-005: solo se status='pending'
  plate?:               string (1..10)
  plateCountry?:        string (2 chars)
  make?:                string (1..50)
  model?:               string (1..100)
  version?:             string|null (max 150)
  year?:                int (1900..currentYear+1)        // BR-007
  registrationDate?:    string (ISO date) | null
  vehicleType?:         enum VehicleType
  fuelType?:            enum FuelType
  engineDisplacement?:  int|null
  powerKw?:             int|null
  color?:               string|null (max 50)
  forceNonstandardVin?: boolean (default false)          // bypass ISO 3779 sul nuovo vin
  force?:               boolean (default false)          // bypass duplicate-plate warning
}

Body deve contenere ≥ 1 campo modificabile (Zod .refine), altrimenti 400.

Response 200:
{
  vehicle: { ...vehicleDetailSelect },         // stesso shape di GET /v1/vehicles/:id
  currentOwnership: { ... } | null             // PII filtrata via BR-151
}

Errori:
  400 ZodError                                  body invalido (campo sconosciuto, vuoto, fuori range)
  404 vehicle.not_found                         id inesistente o RLS-as-404 (tenant non autorizzato)
  409 vehicle.creation.duplicate_vin            BR-001 — nuovo VIN già esistente
  409 vehicle.creation.duplicate_plate_warning  BR-002 — bypass via force=true
  400 vehicle.creation.invalid_vin_checksum     ISO 3779 — bypass via forceNonstandardVin=true
  422 vehicle.modification.vin_immutable        BR-005 — VIN su veicolo non-pending
  422 vehicle.modification.archived             BR-008 — veicolo archived
```

**Riuso codici errore:** i codici `vehicle.creation.duplicate_vin`, `vehicle.creation.duplicate_plate_warning`, `vehicle.creation.invalid_vin_checksum` sono già definiti in `APPENDICE_G`. Riusati invariati sul PATCH perché la semantica è identica (duplicato globale o checksum invalido). Niente nuovi codici.

**Body strict, no silent strip:** mandare `status`, `garageCode`, `certifiedAt`, `createdByTenantId`, ecc. produce 400 ZodError con messaggio "Unrecognized key". Coerente, niente comportamento implicito.

## 3. Authorization

L'enforcement è già in RLS (migration `20260424100000_rls_triggers_checks`):

```sql
CREATE POLICY vehicles_update ON vehicles
FOR UPDATE
USING (
    is_admin_role()
    OR certified_by_tenant_id = current_tenant_id()
    OR created_by_tenant_id = current_tenant_id()
);
```

Strategia application-layer: **nessun pre-check forbidden esplicito**. Il SELECT iniziale passa sempre (`vehicles_read USING (true)` permissive — BR-150 cross-tenant), il forbidden cade in modo naturale al momento dell'UPDATE: 0 righe colpite → Prisma lancia P2025 → handler standard → 404 `vehicle.not_found`.

Pattern "RLS-as-404": coerente con il resto del progetto, security-by-default (non rivela esistenza di un veicolo a tenant non autorizzati), nessun nuovo error code.

## 4. Flusso (handler)

```
1. Parse body (UpdateVehicleSchema .strict + .refine non-empty) → 400 on invalid

2. app.withContext({ tenantId }, async (tx) => { ... })   // RLS-aware tx

3. user = tx.user.findUniqueOrThrow({ cognitoSub })
   → user.id, user.locationId

4. existing = tx.vehicle.findUniqueOrThrow({
     where: { id: params.id },
     select: { vin, plate, plateCountry, status }
   })
   → P2025 → handler → 404 vehicle.not_found
   → SELECT è permissive (vehicles_read USING true): trova SE esiste,
     no auth check qui — il forbidden cade allo step 9.

5. BR-008: if (existing.status === 'archived')
            → throw businessError('vehicle.modification.archived', 422, ...)

6. BR-005: if (body.vin && body.vin !== existing.vin && existing.status === 'certified')
            → throw businessError('vehicle.modification.vin_immutable', 422, ...)

7. Se body.vin presente e diverso:
     - validateVinIso3779 (a meno di forceNonstandardVin)
       → 400 vehicle.creation.invalid_vin_checksum
     - checkDuplicateVin(tx, body.vin)
       → 409 vehicle.creation.duplicate_vin

8. Se body.plate o body.plateCountry presenti e (plate o plateCountry) diversi:
     - checkDuplicatePlateWarning(tx, plate, plateCountry, body.force, excludeId: params.id)
       → 409 vehicle.creation.duplicate_plate_warning
   Note: checkDuplicatePlateWarning va estesa con `excludeId?: string` per evitare
   falsi positivi quando il PATCH reinserisce la stessa plate.

9. tx.vehicle.update({
     where: { id: params.id },
     data: { ...solo campi presenti nel body }   // partial update
   })
   → updatedAt si aggiorna automaticamente (@updatedAt)
   → vehicles_update RLS: se tenant non autorizzato → 0 righe → P2025 → 404

10. recordVehicleAccess({
      tx, vehicleId, tenantId, userId: user.id,
      ...(user.locationId ? { locationId: user.locationId } : {}),
      action: 'update', ipAddress, log
    })

11. Ricarica veicolo + ownerships con vehicleDetailSelect
    Applica resolvePiiVisibility / maskCustomer (BR-151)

12. return 200 { vehicle, currentOwnership }
```

## 5. File touchpoints

**NEW**

- `packages/api/src/routes/v1/vehicles-update.ts` — handler PATCH (~150 righe).
- `packages/api/src/lib/vehicle-shared.ts` — `idParamSchema`, `vehicleDetailSelect`, `vehicleOwnershipSelect` estratti da `vehicles.ts` (~50 righe). Onora il commento esistente `vehicles.ts:13` ("if a second vehicles file grows that needs them, factor out").
- `packages/api/src/lib/business-error.ts` — utility cross-cutting `businessError(code, status, detail)` estratta da `vehicles.ts` (~20 righe). Riusabile da futuri endpoint (PATCH /interventions/:id, archive, transfers, ...).
- `packages/api/tests/integration/vehicles-patch.test.ts` — integration suite (~250 righe).
- `packages/database/src/validators/vehicle.ts` — extend con `UpdateVehicleSchema` (campi optional + `.strict()` + `.refine` non-empty), esposto da `@garageos/database`.

**MODIFIED**

- `packages/api/src/routes/v1/vehicles.ts`:
  - Rimuove `idParamSchema`, `vehicleDetailSelect`, `vehicleOwnershipSelect` locali → import da `lib/vehicle-shared.js`.
  - Rimuove `businessError` locale → import da `lib/business-error.js`.
  - `checkDuplicatePlateWarning` estesa con parametro `excludeId?: string` (escluso il record corrente nel PATCH; nessun effetto sul POST che chiama senza excludeId).
  - Esporta `checkDuplicateVin`, `checkDuplicatePlateWarning` per riuso dal nuovo file.
- `packages/api/src/index.ts` (o file dei route registrati): registra `vehicleUpdateRoutes`.
- `packages/api/tests/unit/routes/v1/vehicles.test.ts`: aggiunge `describe('PATCH /v1/vehicles/:id')` con i casi unit (sezione 6).

**NESSUNA MIGRATION.** Vehicle ha già `updatedAt` (`@updatedAt`), `AccessLogAction` enum ha già `'update'`.

## 6. Testing

### Unit (extend `tests/unit/routes/v1/vehicles.test.ts`)

Stub Prisma + tenantContext + recordVehicleAccess. Coverage:
- Body Zod validation: empty body → 400; unknown field (`status`, `garageCode`) → 400; vin lunghezza errata → 400; year fuori range BR-007 → 400; plateCountry length ≠ 2 → 400.
- Happy path: subset di campi → `tx.vehicle.update` chiamato con solo quei campi.
- VIN unchanged → checksum + duplicate check NON chiamati.
- VIN changed → checksum + duplicate check chiamati.

### Integration (`tests/integration/vehicles-patch.test.ts`)

Setup: Testcontainers Postgres + RLS migration applicata + seed via factories. Coverage:
- Happy path: PATCH `color` → 200, DB row aggiornata, `access_logs` row con `action='update'`.
- PATCH multi-field tecnici → 200, tutti i campi applicati atomicamente.
- BR-005 PATCH vin su `certified` → 422 `vehicle.modification.vin_immutable`.
- BR-005 PATCH vin su `pending` → 200 (allowed).
- BR-001 PATCH vin con duplicato → 409 `vehicle.creation.duplicate_vin`.
- BR-002 PATCH plate con duplicato + `force=false` → 409 `vehicle.creation.duplicate_plate_warning`.
- BR-002 PATCH plate con duplicato + `force=true` → 200.
- BR-002 PATCH plate INVARIATA → 200 (verifica `excludeId` previene falso positivo).
- BR-007 year fuori range → 400.
- BR-008 PATCH veicolo `archived` → 422 `vehicle.modification.archived`.
- VIN checksum: nuovo VIN non-3779 + `forceNonstandardVin=false` → 400.
- VIN checksum: nuovo VIN non-3779 + `forceNonstandardVin=true` → 200.
- PII filter: tenant senza `customer_tenant_relation` → `currentOwnership.customer` mascherato (BR-151).
- RLS forbidden: PATCH da tenant senza `created_by` NÉ `certified_by` → 404 `vehicle.not_found`.
- access_log: `action='update'` + `user_id` + `tenant_id` + `ip` + `location_id` corretti.
- updatedAt: la riga ha `updatedAt > createdAt` dopo PATCH (verifica `@updatedAt`).

### Smoke (manual)

`curl PATCH` con happy path su instance locale via `pnpm dev`.

## 7. Deferred (debt registrato)

Due decisioni esplicitamente rinviate al lavoro frontend, già nel `project_tech_debt.md`:

1. **Concurrency control (last-write-wins → If-Match).** Oggi nessun client. Quando inizia il frontend web officine, verificare se servono race-prevention e wirare `If-Match: <updatedAt ISO8601>` come header opzionale + 412 Precondition Failed (Vehicle ha già `updatedAt`, additive).
2. **Audit del "before" (diff campi prima/dopo).** Oggi solo `access_log action='update'` (BR-005 "tracciato in audit" è soddisfatto). Quando il frontend mostrerà la storia delle modifiche scheda, decidere fra estensione `access_logs.metadata` JSON oppure tabella dedicata `vehicle_change_log`.

## 8. Out of scope (rejected during brainstorming)

- **Service-layer separato (`lib/vehicle-update.ts`):** rifiutato come overengineering per un singolo handler. Logica resta nell'handler.
- **Status PATCH inline (es. `archive` via PATCH `{status: "archived"}`):** rifiutato — `archive` ha logica dedicata (proprietà, notifiche, label "ARCHIVIATO" ovunque) che merita endpoint separato.
- **403 `vehicle.modification.forbidden` esplicito per cross-tenant write:** rifiutato a favore del 404 RLS-as-404 (security-by-default, no nuovo error code).
- **Codici `vehicle.modification.duplicate_vin`/`duplicate_plate` separati dai `creation.*`:** rifiutati — semantica identica, riuso dei `creation.*` esistenti evita proliferazione.

## 9. PR sizing

Stima: ~150 (handler) + 50 (vehicle-shared) + 20 (business-error) + 250 (integration) + 100 (unit) + ~30 (UpdateVehicleSchema) + small edits a vehicles.ts ≈ **~600 righe**, ben sotto il soft target 1500 e l'alert 1200.

## 10. Acceptance checklist (PR-time)

- [ ] Tutti i test elencati in §6 passano (unit + integration).
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`, `pnpm test:integration` verdi.
- [ ] Smoke manuale via `pnpm dev` + curl per il happy path.
- [ ] PR description cita F-OFF-106, BR-001/002/005/007/008/151.
- [ ] Diff non eccede 1200 righe (alert) — split se sfora.
- [ ] Memoria `project_tech_debt.md` ha entrambe le voci `[open] PATCH /v1/vehicles/:id — concurrency` e `[open] PATCH /v1/vehicles/:id — audit del "before"` aggiornate (già fatto durante brainstorming).
