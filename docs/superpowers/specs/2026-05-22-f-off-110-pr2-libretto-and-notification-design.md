# F-OFF-110 PR-2 — Libretto upload + cedente notification

**Status:** design approved (brainstorming output)
**Author:** Claude (Opus 4.7) + Michele Matula
**Date:** 2026-05-22
**Spec ID:** F-OFF-110 (PR-2 follow-up)
**BR:** BR-049 (extends), BR-045 (privacy disclosure), BR-226 (notification preferences)
**Predecessor:** PR #120 (F-OFF-110 PR-1, squash commit `4204b50`)

## Context

F-OFF-110 PR-1 (PR #120) shipped the officina-mediated vehicle transfer: an atomic
single-step ownership swap with a 4-step web wizard (Cessionario → Motivo & note →
Conferma — 3 steps in PR-1). PR-1 deliberately deferred two pieces, recorded in the
PR-1 design (`2026-05-21-f-off-110-officina-mediated-transfer-design.md` §"PR-2 scope")
and in the master spec row for F-OFF-110 ("PR-1 senza upload documento/email
notification (PR-2 follow-up)").

PR-2 delivers those two pieces:

1. **Libretto document upload** — the officina optionally attaches a scan/photo of the
   vehicle registration document (libretto di circolazione) it verified, captured
   during the transfer wizard. BR-049's rationale is that physical presence + document
   verification substitute the remote double-consent of BR-043; PR-2 makes that
   verification part of the digital audit trail.
2. **Cedente email notification** — the previous owner is emailed when the transfer
   completes, informing them the vehicle is no longer registered to them.

## Goals

1. Capture an optional libretto document at transfer time and persist it to
   `VehicleTransfer.documentUrl` (S3 key) for audit/legal record.
2. Notify the cedente (previous owner) by email, best-effort, after the transfer commits.
3. Reuse existing infrastructure end-to-end: the F-OFF-305 S3 client/presign helpers
   and the H1 `lib/notifications` dispatcher. No new AWS resources.
4. Zero database migrations, zero CDK/IAM changes.
5. Keep the transfer atomic — the document is already in S3 before the transaction;
   the transaction only stores the key.

## Non-goals

- **Push notification to the cedente.** No push channel exists in `dispatchNotification`
  today (only the `PushToken` table). Building one (Expo SDK + dispatcher push arm +
  token resolution) is a separate H2 infrastructure slice. PR-2 is email-only.
- **Viewing the stored libretto afterwards.** No transfer-history UI exists and the
  vehicle timeline does not render transfers. The key is on record for audit; an
  operator can retrieve the object from S3 directly if ever needed (legal/dispute).
  A lazy-presign GET endpoint with no consumer would be plumbing without a consumer.
- OCR / automatic validation of the libretto (that is BR-044, mobile claim flow).
- Cessionario notification — BR-045 keeps it silent; the cessionario is physically in
  the shop.
- A notifications outbox table. The H1 dispatcher is fire-and-forget best-effort and
  never throws; the transfer is atomic and BR-047-unique, so the notification fires
  exactly once. An outbox is YAGNI.
- APPENDICE_E test-matrix entry for BR-049 — deferred. Touching `APPENDICE_E_TESTING.md`
  currently trips the pre-commit `secretlint` block on pre-existing PG connection
  strings (tech debt #1). Kept in the cleanup bundle, out of PR-2 scope.

## Divergences from the PR-1 design's PR-2 sketch

The PR-1 design (§"PR-2 scope", lines 407-426) sketched PR-2 before exploration. Three
deliberate corrections:

| PR-1 sketch | PR-2 actual | Reason |
|---|---|---|
| `Migration enum NotificationCategory += 'vehicle_ownership_change'` | No migration | Notification preferences are a JSON blob on `customers.notification_preferences`, not a DB enum. The new key is a TypeScript `EmailEnabledKey` union member + a `DEFAULT_NOTIFICATION_PREFERENCES` entry. |
| `Idempotent via notifications outbox table` | No outbox | H1 dispatcher is best-effort and never throws; the transfer commits once. Outbox is unneeded. |
| `Push best-effort se fromCustomer.cognitoSub != null` | Deferred to H2 | No push channel exists; building one is its own slice. |
| Preference category `vehicle_ownership_change` | Key `ownership_transfer` | Consistent with the `AccessLogAction` value and BR-049 naming. |

## Architecture

### Package boundaries

| Package | Role |
|---|---|
| `@garageos/api` | Presign route + transfer-route extension + transaction-lib extension + new notification event/template/preference + tests |
| `@garageos/web` | New "Documento" wizard step + `useTransferDocumentUpload` hook + payload extension + tests |
| `docs/` | APPENDICE_A endpoint, APPENDICE_F BR-049/BR-226 notes, APPENDICE_G error code, Specifiche row |

### Reused infrastructure (no changes)

- **S3 bucket** `garageos-production-attachments`, env var `S3_ATTACHMENTS_BUCKET`.
- **S3 IAM** — Lambda execution role grants `['s3:GetObject','s3:PutObject']` on
  `${attachmentsBucket.bucketArn}/*` (whole bucket — `infrastructure/lib/constructs/lambda-api.ts:111-115`).
  The new `vehicle-transfers/` key prefix is already covered. `s3:GetObject` authorizes
  the `HeadObject` API call. **No CDK/IAM change.**
- **S3 helpers** — `lib/s3.ts`: `presignPutObject`, `headObject`, `S3ObjectNotFoundError`, `S3UnavailableError`.
- **Notifications** — `lib/notifications/`: `dispatchNotification`, `sendEmail`, `isEmailEnabled`.

## Data model

**No migration.** `VehicleTransfer.documentUrl` (`VARCHAR(500)`, nullable) already
exists in the schema and was the purpose-built target for this in PR-1's design. PR-2
populates it with the S3 key (not a URL — naming is historical).

## API contract

### New: `POST /v1/vehicles/:id/ownership-transfer/document-upload-url`

Registered in the existing route file `packages/api/src/routes/v1/vehicles-ownership-transfer.ts`
(co-located with the transfer route, mirroring how `attachments.ts` holds upload-url +
confirm together).

**Auth:** Cognito JWT officina pool, role `super_admin` or `mechanic`. Same preHandlers
as the transfer route (`requireAuth`, `requireOfficinaPool`, `tenantContext`).

**Path param:** `id` = vehicle UUID.

**Purpose:** issue a presigned S3 PUT URL so the browser can upload the libretto
directly. No DB row is created — the libretto is not an `Attachment`; it becomes a key
stored on `VehicleTransfer.documentUrl` only when (and if) the transfer commits.

**Request body** (Zod):

```ts
{
  fileName: string;   // 1–255 chars
  mimeType: 'image/jpeg' | 'image/png' | 'application/pdf' | 'image/heic';
  sizeBytes: number;  // integer, 1 .. 10_485_760 (10 MB)
}
```

**Behaviour:**

1. Vehicle tenant-scoping: `vehicle.findFirst({ where: { id, tenantId } })` → 404
   `vehicle.not_found` if not visible (RLS-as-404; prevents presigning for arbitrary
   vehicles). No `certified`/ownership checks here — those belong to the transfer route.
2. Generate `documentId = crypto.randomUUID()`.
3. Compute key `vehicle-transfers/<vehicleId>/<documentId>.<ext>` where `ext` is derived
   from `mimeType` (`image/jpeg`→`jpg`, `image/png`→`png`, `application/pdf`→`pdf`,
   `image/heic`→`heic`).
4. `presignPutObject` with `Content-Type: mimeType` and the declared `sizeBytes`
   condition. Expiry 900 s (15 min).

**Response 200:**

```ts
{
  uploadUrl: string;
  uploadMethod: 'PUT';
  uploadHeaders: { 'Content-Type': string };
  s3Key: string;
  expiresAt: string;  // ISO
}
```

**Errors:**

| Status | Code | Guard |
|---|---|---|
| 400 | `validation_error` | Zod parse fail (bad mime, size out of range, empty fileName) |
| 401 | `auth.token_*` | gateway middleware |
| 403 | `vehicle.transfer.role_denied` | non super_admin/mechanic (reused from PR-1) |
| 404 | `vehicle.not_found` | vehicle not visible to tenant |
| 503 | `s3.unavailable` | `S3UnavailableError` from the presigner (reuse existing handling) |

### Extended: `POST /v1/vehicles/:id/ownership-transfer`

The PR-1 request body gains one optional field:

```ts
{
  recipient: /* unchanged discriminated union */,
  reason: 'purchase' | 'inheritance' | 'company_assignment' | 'other',
  notes?: string | null,
  documentS3Key?: string | null   // NEW
}
```

**Validation when `documentS3Key` is present** (all *before* the transaction — S3 is an
external call and must not run inside the Postgres transaction, per
`feedback_cognito_call_outside_postgres_tx`):

1. **Key shape** — must match `^vehicle-transfers/<vehicleId>/<uuid>\.(jpg|png|pdf|heic)$`,
   where `<vehicleId>` is the validated path param (interpolated literally; the param is
   already Zod-`uuid()`-validated, so interpolation is injection-safe). This binds the
   key to *this* vehicle and prevents a client passing another vehicle's or an arbitrary
   key. Mismatch → 422 `vehicle.transfer.document_invalid`.
2. **`headObject(s3Key)`** — `S3ObjectNotFoundError` → 422 `vehicle.transfer.document_invalid`.
3. **Object constraints** — `ContentLength` ≤ 10 MB and `ContentType` ∈ the 4 allowed
   mime types → otherwise 422 `vehicle.transfer.document_invalid`.

The validated key is passed into `performOwnershipTransfer` and stored on the
`VehicleTransfer` row (step 7 of the atomic transaction).

When `documentS3Key` is absent/null, behaviour is identical to PR-1.

**New error code:** `vehicle.transfer.document_invalid` (422). One code covers
missing object, oversized, wrong mime, and malformed key; the RFC 7807 `detail` string
disambiguates for the operator.

## Transaction-lib changes — `lib/ownership-transfer.ts`

`OwnershipTransferInput` gains:

```ts
documentS3Key?: string | null;
```

`OwnershipTransferResult` gains the data the post-commit notification dispatch needs:

```ts
previousOwner: CustomerForNotification | null;  // the cedente; null if deleted/anonymized
vehiclePlate: string;
tenant: { id: string; businessName: string };
transferReason: OwnershipTransferReason;
transferCompletedAt: Date;
```

Changes inside `performOwnershipTransfer`:

- **Step 1 select** — add `plate` to the vehicle select so the result can carry it.
- **Step 2** — after resolving `fromCustomerId` from the current ownership, call the new
  `resolveCustomerForNotification(tx, fromCustomerId)` (see below) and put the result in
  `previousOwner`. This runs inside the transaction so it is part of the consistent
  snapshot; the dispatch itself happens after commit.
- **Step 7** — `vehicleTransfer.create` data includes `documentUrl: input.documentS3Key ?? null`.
- Fetch the tenant's `businessName` (one extra `tenant.findUniqueOrThrow` select) and
  include `{ id, businessName }` in the result, so the route stays thin.

Lock ordering is unchanged (`vehicles` → `vehicle_ownerships` → `vehicle_transfers` →
`customers` → `customer_tenant_relations`); the cedente customer read in step 2 touches
`customers` for SELECT only, no new write, no new lock-graph edge.

## Notification

### New recipient resolver — `lib/notifications/recipient-resolver.ts`

`resolveCurrentOwner` resolves by `vehicleId`, but after the transfer the *current*
owner is the cessionario. The cedente must be resolved by `customerId`. Add a sibling:

```ts
export async function resolveCustomerForNotification(
  tx: Pick<PrismaClient, 'customer'>,
  customerId: string,
): Promise<CustomerForNotification | null>
```

Selects the same fields as `resolveCurrentOwner`'s customer include; applies the same
skips — `status === 'deleted'` → null; anonymized email (`deleted-*@garageos.it`,
BR-158) → null.

### New event variant — `lib/notifications/types.ts`

```ts
export interface VehicleForEmail {
  id: string;
  plate: string;
}

// added to the NotificationEvent union:
| {
    type: 'ownership.transferred';
    vehicle: VehicleForEmail;
    tenant: TenantForEmail;
    transferReason: 'purchase' | 'inheritance' | 'company_assignment' | 'other';
    transferredAt: string;  // ISO
  }
```

`EmailEnabledKey` gains `'ownership_transfer'`.

### Preference gate — `lib/notification-preferences.ts` + `lib/notifications/preferences.ts`

`isEmailEnabled` falls back to `DEFAULT_NOTIFICATION_PREFERENCES.email[key]` when the
customer's stored prefs lack the key. Therefore `DEFAULT_NOTIFICATION_PREFERENCES.email`
**must** gain `ownership_transfer: true` (also enforced by typecheck — `email[key]` is
indexed by `EmailEnabledKey`). Add `ownership_transfer: true` to the `push` block too,
for symmetry with the existing keys (all keys appear in both blocks); push is not
consumed in PR-2.

Default **on**: losing ownership of a vehicle is a significant transactional event the
customer should hear about unless they explicitly opted out.

`preferenceKeyForEvent` in `dispatcher.ts` gains
`case 'ownership.transferred': return 'ownership_transfer';`. The switch is exhaustive
with no `default`, so typecheck enforces the new case.

### Email template — `lib/notifications/templates/ownership-transferred.ts`

Mirrors `intervention-cancelled.ts`:

- `OWNERSHIP_TRANSFERRED_SUBJECT = 'La proprietà del tuo veicolo è stata trasferita'`
- `renderOwnershipTransferredHtml(input)` / `renderOwnershipTransferredText(input)`
  where `input = { recipient, vehicle, tenant, transferReason, transferredAt }`.
- Display name: business → `businessName`, else `firstName`.
- Reason localization: `purchase`→"Vendita", `inheritance`→"Eredità",
  `company_assignment`→"Assegnazione aziendale", `other`→"Altro".
- Body (IT): informs the cedente that the vehicle with plate `<plate>` was transferred
  on `<date>` by the officina `<tenant businessName>`, with the reason; states the
  BR-045 consequence — "non avrai più accesso allo storico interventi di questo veicolo".
- HTML-escape all interpolated values (plate, tenant name, display name) — XSS, same as
  `intervention-cancelled.ts`.
- **No deep link** — per BR-045 the cedente no longer has access to the vehicle.
- Footer: BR reference + preference disclosure, consistent with existing templates.

### Dispatch wiring — transfer route

After `performOwnershipTransfer` returns, in the route handler (after the transaction
has committed):

```ts
if (result.previousOwner) {
  await dispatchNotification({
    event: {
      type: 'ownership.transferred',
      vehicle: { id: vehicleId, plate: result.vehiclePlate },
      tenant: result.tenant,
      transferReason: result.transferReason,
      transferredAt: result.transferCompletedAt.toISOString(),
    },
    recipient: result.previousOwner,
    logger: request.log,
  });
}
```

`dispatchNotification` never throws (documented contract) — a notification failure
never affects the already-committed transfer or the 200 response.

### SES sandbox note

SES is still in sandbox pending the AWS T&S/SES prod-exit ticket
(`feedback_ses_prod_exit_gated_by_t_and_s`). In sandbox, email delivers only to verified
addresses; in production the cedente email may not deliver until SES exits sandbox. The
dispatcher is best-effort and logs the failure — this is an operational limitation, not
a code defect, and does not block PR-2.

## Web UI

### Wizard — `OwnershipTransferDialog.tsx`

The wizard goes from 3 to **4 steps**:

1. Cessionario *(unchanged)*
2. Motivo & note *(unchanged)*
3. **Documento** *(new)*
4. Conferma *(was step 3)*

New dialog state: `documentS3Key: string | null`, `documentFileName: string | null`.

**Step 3 — Documento:**

- The step is optional. Heading + helper text make clear the libretto can be skipped
  ("Carica il libretto di circolazione verificato, oppure salta questo passaggio").
- No file selected: a file-picker button (`accept` = the 4 mime types) and an enabled
  "Avanti" button (skipping is allowed).
- File selected: client-side validation via `lib/attachmentValidation.ts`
  (`validateFileForUpload` — mime in allowed set, ≤ 10 MB). On failure, inline error,
  no upload.
- Uploading: progress bar driven by the hook's `uploading` phase.
- Uploaded: file name + size + a success indicator, plus a "Rimuovi" control that
  clears `documentS3Key`/`documentFileName` (the orphaned S3 object is left — accepted,
  same as F-OFF-305 abandoned uploads).
- Error: inline message + retry.
- "Avanti" advances to step 4 whether or not a document was uploaded.

**Step 4 — Conferma:** the summary gains a line — "Libretto: `<fileName>`" when a
document was uploaded, "Nessun documento allegato" otherwise.

**Submit:** the mutation payload includes `documentS3Key` (the uploaded key, or `null`).

### Upload hook — `queries/transferDocumentUpload.ts`

New `useTransferDocumentUpload(vehicleId: string)`, modelled on `useAttachmentUpload`
but simpler — there is no confirm step (no `Attachment` row):

- State machine: `{ phase: 'idle' } | { phase: 'requesting' } | { phase: 'uploading'; progress: number } | { phase: 'success'; s3Key: string; fileName: string } | { phase: 'error'; code: string; message: string }`.
- `upload(file: File): Promise<{ ok: true; s3Key: string } | { ok: false; code: string; message: string }>`
  — discriminated return so the dialog branches on the result, not on post-`await`
  state (`feedback_hook_return_result_not_state`).
- Step 1: `POST .../ownership-transfer/document-upload-url`.
- Step 2: `XMLHttpRequest` PUT to `uploadUrl` with the `Content-Type` header, emitting
  progress events.
- `reset()` to return to `idle`.

### Mutation hook — `queries/ownershipTransfer.ts`

`OwnershipTransferPayload` gains `documentS3Key?: string | null`. No change to the
success-invalidation set.

### i18n

All new strings in Italian through the existing i18n system, no hardcoding.

## Error handling summary

| Surface | Failure | Result |
|---|---|---|
| Presign endpoint | bad input | 400 `validation_error` |
| Presign endpoint | vehicle not visible | 404 `vehicle.not_found` |
| Presign endpoint | S3 presigner down | 503 `s3.unavailable` |
| Transfer route | `documentS3Key` malformed / object missing / oversized / wrong mime | 422 `vehicle.transfer.document_invalid` |
| Web Documento step | client validation fail | inline error, no upload |
| Web Documento step | upload network error | inline error + retry; skip still possible |
| Notification dispatch | SES error / pref-off / deleted cedente | best-effort: logged, transfer + 200 unaffected |

## Testing strategy

Local gate is `pnpm -r typecheck` only; CI runs the full suites
(`feedback_skip_local_integration_tests`).

### API unit tests

- **Presign route** (new file `packages/api/tests/unit/routes/v1/vehicles-ownership-transfer-document-url.test.ts`):
  Zod validation branches, mime→ext mapping, key format, 404 path. `FakePrisma` needs a
  `vehicle` group.
- **Transfer route `documentS3Key`** (extend `packages/api/tests/unit/routes/v1/vehicles-ownership-transfer.test.ts`):
  malformed-key rejection, `headObject` not-found → 422, oversized/wrong-mime → 422,
  valid key → passed through. Mock `headObject`; set fake `AWS_ACCESS_KEY_ID` /
  `AWS_SECRET_ACCESS_KEY` in test setup (`feedback_aws_sdk_presigner_credentials_chain`).
- **Notification dispatch wiring**: with a resolvable cedente, `dispatchNotification` is
  invoked with an `ownership.transferred` event; with a deleted/anonymized cedente, it
  is not.
- **Template** (new file `packages/api/tests/unit/lib/notifications/templates/ownership-transferred.test.ts`):
  business vs individual display name, reason localization, HTML escaping, no deep link.

### API integration tests

Extend `packages/api/tests/integration/vehicles-ownership-transfer.test.ts` with new
`describe` blocks (unique `remoteAddress` per block —
`feedback_integration_test_rate_limit_isolation`):

1. Presign happy path → 200 with a `vehicle-transfers/<vehicleId>/…` key.
2. Presign 404 for a vehicle of another tenant.
3. Transfer with a valid `documentS3Key` → 200, `VehicleTransfer.documentUrl` persisted.
4. Transfer with a key that does not point to a real S3 object → 422
   `vehicle.transfer.document_invalid`.
5. Transfer with a key for a different vehicle → 422.
6. **Regression:** transfer with no `documentS3Key` still → 200 (PR-1 behaviour intact).

S3 in integration tests: follow the existing F-OFF-305 attachment integration approach
(real object PUT to the test bucket, or the established S3 stub) — match whatever
`attachments.ts` integration tests already do; do not introduce a new S3 test strategy.

### Web component tests

Extend `OwnershipTransferDialog.test.tsx`:

- The Documento step renders; "Avanti" proceeds with no file (skip path).
- Selecting an oversized / wrong-mime file shows an inline validation error.
- A successful upload surfaces the file name and flows `documentS3Key` into the submit
  payload.
- The Conferma summary shows the file name when present, "Nessun documento allegato"
  otherwise.

Use `userEvent` for Radix interactions (`feedback_radix_tabs_user_event_not_fire_event`);
rely on the jest single-React-instance mapper (`feedback_local_env_blocks_test_validation`).

A focused test for `useTransferDocumentUpload` (presign call shape, progress, error
discriminated return) — new file or co-located, matching the F-OFF-305 hook-test
convention.

### BR coverage

| BR | Test type | Where |
|---|---|---|
| BR-049 (libretto capture) | API integration | `vehicles-ownership-transfer` (documentUrl persisted) |
| BR-045 (privacy in email) | API unit | `ownership-transferred` template (no deep link, disclosure text) |
| BR-226 (preference gate) | API unit | dispatch wiring (pref-off → not sent) |

## Documentation updates

- `docs/APPENDICE_A_API.md` — add `POST /vehicles/:id/ownership-transfer/document-upload-url`;
  update the transfer endpoint body to show the optional `documentS3Key`; add
  `vehicle.transfer.document_invalid` to its error table.
- `docs/APPENDICE_F_BUSINESS_LOGIC.md` — BR-049: note that the officina-mediated
  transfer optionally captures the verified libretto (`VehicleTransfer.documentUrl`)
  and emails the cedente. BR-226: add the `ownership_transfer` email key (version bump).
- `docs/APPENDICE_G_ERROR_CODES.md` — register `vehicle.transfer.document_invalid` (422).
- `docs/GarageOS-Specifiche.md` — F-OFF-110 row: drop the
  "PR-1 senza upload documento/email notification (PR-2 follow-up)" qualifier now that
  PR-2 ships it.
- `docs/APPENDICE_E_TESTING.md` — **not touched** (secretlint blocker, see Non-goals).

## Files touched (estimate)

| Area | File | LOC est |
|---|---|---|
| API route | `routes/v1/vehicles-ownership-transfer.ts` (presign route + `documentS3Key` handling) | +130 |
| API lib | `lib/ownership-transfer.ts` (input/result + documentUrl + cedente resolve) | +40 |
| API notifications | `lib/notifications/recipient-resolver.ts` (`resolveCustomerForNotification`) | +25 |
| API notifications | `lib/notifications/types.ts` + `dispatcher.ts` + `preferences` | +35 |
| API notifications | `lib/notifications/templates/ownership-transferred.ts` (new) | +70 |
| API unit tests | presign test (new) + transfer test (extend) + template test (new) | +160 |
| API integration tests | `vehicles-ownership-transfer.test.ts` (extend) | +120 |
| Web hook | `queries/transferDocumentUpload.ts` (new) | +100 |
| Web hook | `queries/ownershipTransfer.ts` (payload field) | +5 |
| Web component | `OwnershipTransferDialog.tsx` (Documento step) | +110 |
| Web tests | `OwnershipTransferDialog.test.tsx` (extend) + hook test (new) | +110 |
| Docs | APPENDICE_A, _F, _G, Specifiche | +40 |
| **Total** | | **~945** |

Realistically ~800–950 LOC. Above the PR-1 design's ~400-600 sketch (email + S3 + the
test volume add up), but a healthy single PR — comparable to prior slices and well
under the 1500-LOC hard limit. Mid-execution LOC checkpoint
(`feedback_mid_execution_loc_checkpoint`): soft warn 1000, stop-and-ask 1200.

## Open notes (non-blocking)

1. S3 strategy in integration tests must match the existing F-OFF-305 attachment
   integration approach — confirm during implementation, do not invent a new one.
2. `isEmailEnabled` typecheck will fail until `ownership_transfer` is added to
   `DEFAULT_NOTIFICATION_PREFERENCES.email`; both edits land in the same task.
3. The presign route's `s3.unavailable` 503 path should reuse whatever
   `S3UnavailableError` handling `attachments.ts` already has — match it.

## Memory references applicable

- `feedback_cognito_call_outside_postgres_tx` — S3 `headObject` runs before the transaction
- `feedback_aws_sdk_presigner_credentials_chain` — fake AWS creds in test setup
- `feedback_avatar_url_serializer_pattern` — S3 key stored in DB (not a URL)
- `feedback_middleware_throw_fastifyerror_not_reply_send` — `businessError` for 4xx codes
- `feedback_rls_split_changes_endpoint_semantics` — `findFirst({id,tenantId})` + null check
- `feedback_handler_change_breaks_unit_mock` — `FakePrisma` group coverage when extending handlers
- `feedback_hook_return_result_not_state` — discriminated return from the upload hook
- `feedback_radix_tabs_user_event_not_fire_event` — `userEvent` in component tests
- `feedback_integration_test_rate_limit_isolation` — unique `remoteAddress` per describe block
- `feedback_field_name_drift_api_vs_db` — explicit field mapping (`codiceFiscale`/`taxCode` lesson)
- `feedback_ses_prod_exit_gated_by_t_and_s` — SES sandbox limitation
- `feedback_lambda_iam_admin_enable_user_gap` — IAM verified (no change needed this time)
- `feedback_skip_local_integration_tests` — pre-push typecheck only
- `feedback_subagent_driven_review_loop` — 3-stage review pattern for execution
