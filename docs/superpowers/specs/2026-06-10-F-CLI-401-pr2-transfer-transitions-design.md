# F-CLI-401 PR2 — Transfer transitions + atomic swap (design)

**Date:** 2026-06-10
**Feature:** F-CLI-401 (covers F-CLI-402 acquisizione, F-CLI-403 doppia conferma, F-CLI-405 pulizia interventi privati)
**Arc:** Customer-side ownership transfer (F-CLI-401→405). PR1 (avvio+lettura) shipped in #180 (`cb6a157`). This is **PR2 of 4**: PR3 = scheduler 7d-expiry, PR4 = mobile.
**Surface:** API only. **No migration / dependency / CDK / deploy.**

## 1. Goal

Make the customer-initiated transfer row created by PR1 actually move ownership, via the BR-043 double-confirmation flow:

```
pending_recipient ──accept(recipient)──▶ pending_seller_confirmation ──confirm(seller)──▶ completed (swap)
        │                                          │
        └──────────── reject(either) ──────────────┴──────────▶ rejected
```

Three new handlers in the existing `routes/v1/me-transfers.ts`:

| Endpoint | Caller | Path key | Effect |
|---|---|---|---|
| `POST /v1/me/transfers/:code/accept` | recipient (≠ seller) | `transferCode` | sets `toCustomerId = caller`; `pending_recipient → pending_seller_confirmation`; resets `expiresAt` |
| `POST /v1/me/transfers/:id/confirm` | seller (`fromCustomerId`) | `id` | `pending_seller_confirmation → completed` + **atomic ownership swap** |
| `POST /v1/me/transfers/:id/reject` | either party (`from` or `to`) | `id` | any active state → `rejected`; optional `reason` → `rejectedReason` |

All three return the serialized transfer via the existing `serializeTransfer` (it already renders `completedAt` / `rejectedReason`).

## 2. Security model

Identical to PR1: `vehicles`, `vehicle_ownerships`, `vehicle_transfers` RLS are all `USING(true)`, so all three handlers run under **`role:'user'`** — no admin elevation. This matches the customer `claim` precedent (`me-vehicles.ts:345` creates a `vehicleOwnership` under `role:'user'`).

RLS is not the security boundary (the #154 lesson). **Every handler authorizes app-layer** against `fromCustomerId` / `toCustomerId`:

- `accept`: caller must **not** be `fromCustomerId` (can't accept your own transfer).
- `confirm`: caller must be `fromCustomerId`.
- `reject`: caller must be `fromCustomerId` **or** `toCustomerId`.

No recipient/seller PII is ever returned (the DTO already omits anagrafica — BR-045/BR-151).

## 3. Reuse decision — dedicated swap helper

`lib/ownership-transfer.ts:performOwnershipTransfer` (F-OFF-110, officina-mediated) is **left untouched**. It diverges from the customer flow on almost everything structural:

| Concern | `performOwnershipTransfer` (officina) | customer `confirm` swap |
|---|---|---|
| Vehicle scoping | tenant (`createdBy/certifiedByTenantId`) | none — caller is a customer |
| Recipient | *resolves/creates* the customer | already set at `accept` (`toCustomerId`) |
| Transfer row | **creates** it (`status='completed'`) | **updates** the existing row → `completed` |
| AccessLog | writes one (NOT-NULL `tenantId`+`userId`) | **none** — no tenant/user actor |
| Notification | resolves previous owner for tenant notify | deferred (see §7) |

Parametrizing `method`/`status` would not cover these; it would force officina-shaped params (tenantId, actorUserId, recipient resolution) the customer flow has to fake. So PR2 ships a small purpose-built helper:

```
lib/transfer-swap.ts → confirmTransferSwap(tx, { transferId, vehicleId, fromCustomerId, toCustomerId, now })
```

### 3.1 Swap algorithm — compare-and-swap, lock-order `vehicle_transfers → vehicle_ownerships`

1. **CAS the transfer to completed** (atomic guard against concurrent confirm):
   ```
   const r = await tx.vehicleTransfer.updateMany({
     where: { id: transferId, status: 'pending_seller_confirmation' },
     data:  { status: 'completed', completedAt: now },
   });
   if (r.count === 0) → lost the race; caller re-reads to surface the right 4xx
   ```
   On UPDATE to `completed` the row leaves the `uq_transfer_vehicle_active` partial-index predicate, freeing the BR-047 slot.

2. **Close old ownership:**
   ```
   const closed = await tx.vehicleOwnership.updateMany({
     where: { vehicleId, customerId: fromCustomerId, endedAt: null },
     data:  { endedAt: now, transferReason: 'purchase', transferNotes: null },
   });
   if (closed.count === 0) → throw transfer.confirmation.ownership_conflict (409)
   ```
   Near-unreachable: while the transfer was `pending_seller_confirmation` it held the BR-047 active-slot, blocking any competing claim / officina transfer. Defensive guard only.

3. **Open new ownership** for `toCustomerId`, guarded against the active-ownership unique index (mirrors `me-vehicles.ts:353`):
   ```
   try { create({ vehicleId, customerId: toCustomerId, startedAt: now }) }
   catch P2002 on uq_ownership_vehicle_active → throw transfer.confirmation.ownership_conflict (409)
   ```

4. **No AccessLog**, **no CTR upsert**, no recipient resolution.

`transferReason`: the customer flow has no reason picker; the swap defaults to `'purchase'` — the only B2C-meaningful `OwnershipTransferReason` enum value. *(Assumption, flagged for review.)*

## 4. `expiresAt` semantics (BR-043 timeout)

- **create** (PR1): `expiresAt = created + 7d` — recipient must accept within 7 days.
- **accept** (PR2): `expiresAt = accepted + 7d` — **reset**, because BR-043's confirmation window is "7 giorni *dall'accettazione del cessionario*". The seller now has 7 days from acceptance to confirm.
- **confirm** (PR2): guarded by `expiresAt > now`.
- PR3 scheduler will expire rows past `expiresAt` in `pending_recipient` **or** `pending_seller_confirmation`.

## 5. Validations & error codes

All under APPENDICE_G's already-blessed `transfer.acceptance.*` / `confirmation.*` / `rejection.*` prefixes. **4 new leaves** added (grep-confirmed they do not exist yet; PR1 legitimately added `transfer.creation.vehicle_not_found` the same way).

### accept — lookup by `transferCode`
| Condition | Code | HTTP | New? |
|---|---|---|---|
| code not found | `transfer.not_found` | 404 | reuse |
| status `completed` | `transfer.acceptance.already_completed` | 409 | reuse |
| status rejected/expired/other ≠ `pending_recipient` | `transfer.acceptance.not_pending_recipient` | 422 | reuse |
| `expiresAt < now` | `transfer.acceptance.expired` | 410 | reuse |
| caller `== fromCustomerId` | `transfer.acceptance.self_not_allowed` | 403 | **NEW** |
| success | — sets `toCustomerId=caller`, status→`pending_seller_confirmation`, `expiresAt=now+7d` | 200 | — |

### confirm — lookup by `id`
| Condition | Code | HTTP | New? |
|---|---|---|---|
| id not found | `transfer.not_found` | 404 | reuse |
| row exists, `fromCustomerId ≠ caller` | `transfer.confirmation.not_from_customer` | 403 | reuse |
| status ≠ `pending_seller_confirmation` | `transfer.confirmation.not_pending_seller` | 422 | reuse |
| `expiresAt < now` | `transfer.confirmation.expired` | 410 | **NEW** |
| swap conflict (§3.1 steps 2/3) | `transfer.confirmation.ownership_conflict` | 409 | **NEW** |
| success | — status→`completed`, ownership swapped | 200 | — |

CAS lost-race (`count===0` in step 1): re-read the row and surface `not_pending_seller` (422) — the concurrent winner already advanced the status.

### reject — lookup by `id`
| Condition | Code | HTTP | New? |
|---|---|---|---|
| id not found | `transfer.not_found` | 404 | reuse |
| caller ∉ {`fromCustomerId`, `toCustomerId`} | `transfer.rejection.not_permitted` | 403 | reuse |
| terminal status (`completed`/`rejected`/`expired`) | `transfer.rejection.not_pending` | 409 | **NEW** |
| success | — status→`rejected`, `rejectedReason = body.reason ?? null` | 200 | — |

Request body for reject: `{ reason?: string }` (optional, trimmed, max 500 — stored in `rejected_reason`). accept/confirm take **no body** (path param only).

## 6. F-CLI-405 / BR-045 — private interventions stay hidden

Structurally guaranteed already: `private_interventions` RLS is `customer_id`-scoped (`private_int_isolation`), and the swap **never touches that table**. The seller's private interventions remain bound to the vehicle but RLS-hidden from the new owner. **Verified by an integration test only — no production code.**

Out of scope for PR2 (read-side / mobile concerns, deferred): the seller's "veicolo ceduto" labelling of their retained private interventions (BR-045 "il cedente conserva…").

## 7. Deferred (with `TODO(F-CLI-…)` markers at the hook points)

- **Notifications**: ownership_transfer push/email (notify seller on accept, recipient on confirm) — belongs to the dedicated notifications arc, like every other event. Post-commit dispatch hook points are marked but not wired.
- **email_invitation** method and `invited_email_mismatch` acceptance branch — the whole arc is `physical_code` only until SES/Resend is unblocked.
- **7-day auto-expiry** — PR3 scheduler.

## 8. Files

- `lib/transfer-swap.ts` — **new**, `confirmTransferSwap` helper.
- `routes/v1/me-transfers.ts` — +3 handlers (accept/confirm/reject).
- `docs/APPENDICE_G_ERROR_CODES.md` — +4 leaves (table §3xx + alphabetical index §7).
- `docs/APPENDICE_A_API.md` — mark the 3 endpoints implemented (PR2 note, mirror PR1's note style).

No migration / dependency / CDK / deploy.

## 9. Testing

**Unit (FakePrisma, Vitest):** per-handler auth + status + expiry branches; CAS lost-race path; reject by from and by to; self-accept block; reject-terminal block; `expiresAt` reset on accept.

**Integration (real Postgres):**
- Happy path: create → accept → confirm → assert ownership actually moved (old `endedAt` set, new active row for recipient), transfer `completed`.
- `expiresAt` reset on accept; confirm past expiry → 410.
- Reject by seller (pending_recipient) and by recipient (pending_seller_confirmation).
- Self-accept → 403; accept non-pending → 422; reject completed → 409.
- **F-CLI-405**: after swap, new owner's read surface does not expose the seller's `private_interventions`.
- Concurrent double-confirm → exactly one swap, the loser gets a clean 4xx (CAS).

## 10. Open assumptions (flagged for spec review)

1. `transferReason='purchase'` default on the customer swap (no reason picker in B2C).
2. 4 new error-code leaves under blessed prefixes (§5).
3. accept resets `expiresAt` (BR-043 confirmation window starts at acceptance).
