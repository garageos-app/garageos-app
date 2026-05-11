# Edit intervento dalla timeline — design spec

**Slice C — vertical, web-heavy.** Officina users edit a previously created
intervention directly from the vehicle timeline via a dialog modal. Backend
PATCH endpoint already exists (F-OFF-304, `interventions-update.ts`); this
slice ships the web UI plus a minimal timeline DTO extension.

- **Date:** 2026-05-11
- **Feature ref:** F-OFF-303 (Modifica intervento da timeline)
- **Backend ref:** F-OFF-304 (PATCH endpoint, shipped pre-pivot)
- **Business rules:** BR-061, BR-062, BR-063, BR-064, BR-065, BR-128, BR-130

## Goals

1. Officina opens a vehicle timeline, locates an intervention, and edits its
   5 mutable fields (`title`, `description`, `internalNotes`, `partsReplaced`,
   `interventionTypeId`) without leaving the timeline page.
2. UX communicates BR-062 wiki window vs locked state upfront, so the user
   understands whether the edit will be silent (wiki) or audited+notified
   (post-lock).
3. Post-lock edits force a `reason` ≥10 chars; client validates before round
   trip.
4. Cancelled/disputed interventions hide the edit affordance entirely
   (terminal states, BR-128/BR-130).

## Non-goals

- Editing immutable fields (`vehicleId`, `interventionDate`, `odometerKm`,
  `locationId`, `userId`, `tenantId`) — BR-061 forbids; not exposed.
- Editing deadlines (BR-080 deadline auto-create is creation-only).
- Editing attachments on the intervention itself (separate F-OFF-305 web
  upload UI lives in its own slice).
- Showing the revision history inside the edit dialog (separate
  `GET /v1/interventions/:id/revisions` consumer — future slice).
- Optimistic concurrency / version etag (last-write-wins is acceptable for v1).
- Pre-emptive role gating in the UI (`AuthContext` does not expose role;
  officina dashboard route guard is the existing fence).
- Countdown copy in BR-062 banner (binary wiki/locked is enough; avoids
  clock-skew complexity).

## Architecture

### Backend extension

One file modified, ~3 LOC of production code.

**`packages/api/src/routes/v1/vehicles-timeline.ts`:**

- Extend `shopRowSelect` with `wikiLockedAt: true` and add `id: true` to
  the existing `interventionType` nested select (currently only `code`
  and `nameIt`; the edit dialog needs the type UUID to pre-populate the
  `<Select>`).
- In the shop branch of the DTO mapper (around line 282–299):
  - Add `id: r.interventionType.id` to the `type` object alongside `code`
    and `name_it`.
  - Add `wiki_locked_at: r.wikiLockedAt ? r.wikiLockedAt.toISOString() : null`
    to the row.
- No handler logic change. No new BR. No new route.

**`packages/api/tests/integration/vehicles-timeline.test.ts`:**

- Extend one existing officina-timeline assertion to confirm
  `wiki_locked_at` is present (null for fresh row).
- Add one new scenario that creates an intervention with `wikiLockedAt`
  pre-set (helper extension) and asserts the ISO string surfaces.

**`docs/APPENDICE_A_API.md` §2.5:**

- Add `wiki_locked_at` to the shop-intervention timeline row response shape:
  nullable ISO 8601 UTC timestamp; null = wiki window open; non-null =
  locked, audit trail active for any subsequent PATCH.

No changes to the PATCH handler itself — error codes, BR enforcement, and
revision row creation are already in place.

### Web — files added

- **`packages/web/src/components/EditInterventionDialog.tsx`** — main
  component, ~220 LOC. Dialog modal wrapping an RHF + Zod form with the
  5 editable fields, the BR-062 banner, and the conditional `reason` field.
- **`packages/web/src/components/EditInterventionDialog.test.tsx`** —
  ~180 LOC, 6–7 scenarios (see Testing).
- **`packages/web/src/queries/updateIntervention.ts`** —
  `useUpdateIntervention` mutation hook, ~50 LOC.
- **`packages/web/src/queries/updateIntervention.test.tsx`** — ~120 LOC,
  5 scenarios.
- **`packages/web/src/lib/validators/editIntervention.ts`** —
  `EditInterventionFormSchema` (Zod), ~40 LOC.
- **`packages/web/src/lib/validators/editIntervention.test.ts`** — ~3 unit
  scenarios for the schema.

### Web — files modified

- **`packages/web/src/components/TimelineRow.tsx`** — add an "Modifica"
  button inside the expanded panel (visible only if `status` ∈
  {`created`, `reviewed`}); wire it to a controlled `<EditInterventionDialog>`.
  Add `wikiLockedAt: string | null` to consumed `TimelineItem` props.
- **`packages/web/src/components/TimelineRow.test.tsx`** — 3 new scenarios
  (button visible for active status, hidden for `cancelled` and `disputed`,
  click opens dialog with the right props).
- **`packages/web/src/queries/types.ts`** — extend `TimelineItem` shape with
  `wiki_locked_at: string | null` and (camelCase) `wikiLockedAt: Date | null`
  after the mapper.
- **`packages/web/src/queries/vehicleTimeline.ts`** — surface
  `wiki_locked_at` through the existing mapper (parse ISO string to `Date`,
  preserving null).

### Reused without modification

- `PartsRepeater` (field array for `partsReplaced`).
- `Dialog`, `DialogContent`, `DialogHeader`, `DialogFooter`, `Alert`,
  `Button`, `Textarea`, `Input`, `Label` — shadcn primitives.
- `useInterventionTypes` query hook (CreateIntervention already populates
  the same cache key; reused for the type `<Select>`).
- `collectErrorMessages` walker recursive helper (pattern from PR #64) to
  surface validation errors in collapsed sections.

## Data flow

### Opening the dialog

1. User expands a timeline row in `TimelineRow.tsx`.
2. If `status ∈ { 'created', 'reviewed' }`, the expanded panel renders a
   "Modifica" button in the action bar inside the expanded panel.
   "Modifica" and "Rispondi disputa" are mutually exclusive (the dispute
   response action is gated by `is_disputed === true` ⇒ `status ===
   'disputed'`, which is one of the hidden cases for "Modifica"), so the
   action bar shows exactly one primary action at a time.
3. Click toggles a local `editOpen` state. `<EditInterventionDialog
   open={editOpen} onOpenChange={setEditOpen} intervention={item}
   vehicleId={vehicleId} />` mounts.
4. RHF initializes `defaultValues` from `intervention`:
   - `interventionTypeId` ← `intervention.type.id` (DTO extension above
     surfaces this).
   - `title`, `description`, `internalNotes` ← direct copy.
   - `partsReplaced` ← copy array (defensive clone via
     `JSON.parse(JSON.stringify(...))`).
   - `reason` ← empty string.
5. Banner derives from `wikiLockedAt`: `null` → "Modifiche libere",
   non-null → "Audit attivo".
6. Reason textarea renders only when `wikiLockedAt !== null`.
7. Collapsible section expansion state defaults from current values:
   `showTitle = !!intervention.title`, `showParts = (parts.length > 0)`,
   `showNotes = !!intervention.internalNotes`. Pattern copied from
   `InterventionForm.tsx`.

### Submitting

1. RHF runs `zodResolver(EditInterventionFormSchema)`. Errors collected
   via `collectErrorMessages` walker and rendered top-of-dialog.
2. Dialog runs a post-Zod conditional check: if `wikiLockedAt !== null`
   and `reason.trim().length < 10`, calls
   `methods.setError('reason', ...)` and aborts.
3. Dialog computes a diff vs `defaultValues` using a small helper
   `buildPatchBody(values, original)`. Each of the 5 fields is included
   only when changed (deep equality for `partsReplaced`).
4. If the diff is empty, dialog renders a form-level error
   "Nessuna modifica da salvare" and skips the API call.
5. `useUpdateIntervention.mutate({ id, body: diff })` issues
   `PATCH /v1/interventions/:id`.
6. **Success**:
   `queryClient.invalidateQueries({ queryKey: ['vehicleTimeline', vehicleId] })`,
   toast "Intervento aggiornato", `onOpenChange(false)`.
7. **Error mapping**: see "Error handling" below.

### React Query keys

- Read: `['vehicleTimeline', vehicleId, filters]` (existing).
- Mutation: no key; invalidates timeline on success.
- No optimistic update.

### Concurrency

Last-write-wins. No version/etag. Two officina operators editing the same
intervention simultaneously: the second commit overrides the first. The
revision log preserves both writes when locked. Acceptable for v1.

## Form schema and validation

### `EditInterventionFormSchema`

```ts
import { z } from 'zod';
import { PartReplacedSchema } from '@garageos/database';

export const EditInterventionFormSchema = z.object({
  interventionTypeId: z.string().uuid().optional(),
  title: z.string().max(200).nullable().optional(),
  description: z.string().min(1).max(5000).optional(),
  partsReplaced: z.array(PartReplacedSchema).optional(),
  internalNotes: z.string().max(5000).nullable().optional(),
  reason: z.string().max(2000).optional(),
});

export type EditInterventionFormValues = z.infer<typeof EditInterventionFormSchema>;
```

Notes:

- Schema deliberately does NOT enforce "at least one field changed" — that
  check needs `defaultValues` context which Zod has no access to. The
  dialog handles it via the diff step.
- Schema does NOT enforce `reason` ≥10 chars when locked. Same reason:
  the constraint depends on `wikiLockedAt`, a prop external to the form.
  Dialog handles via `setError`.
- `PartReplacedSchema` is the same export used by the create form
  (`@garageos/database`), keeping parts validation symmetric.

### Diff helper

```ts
function buildPatchBody(
  values: EditInterventionFormValues,
  original: EditInterventionDefaults,
): Partial<EditInterventionFormValues> {
  const patch: Partial<EditInterventionFormValues> = {};
  if (values.interventionTypeId !== original.interventionTypeId) {
    patch.interventionTypeId = values.interventionTypeId;
  }
  if (values.title !== original.title) patch.title = values.title ?? null;
  if (values.description !== original.description) patch.description = values.description;
  if (values.internalNotes !== original.internalNotes) {
    patch.internalNotes = values.internalNotes ?? null;
  }
  if (!partsEqual(values.partsReplaced ?? [], original.partsReplaced ?? [])) {
    patch.partsReplaced = values.partsReplaced ?? [];
  }
  return patch;
}
```

`partsEqual` performs structural comparison: array length first, then
`JSON.stringify` on each item canonicalized by sorting keys. The naive
`JSON.stringify(values) === JSON.stringify(original)` is acceptable
because both arrays originate from the same Zod schema parse and React
Hook Form preserves the field-array insertion order.

## BR-062 banner and reason field UX

### Banner

Two variants, mutually exclusive:

```tsx
{wikiLockedAt === null ? (
  <Alert>
    <InfoIcon className="h-4 w-4" />
    <AlertDescription>
      Modifiche libere. La modifica non sarà tracciata né visibile al
      cliente.
    </AlertDescription>
  </Alert>
) : (
  <Alert variant="warning">
    <AlertTriangleIcon className="h-4 w-4" />
    <AlertDescription>
      Audit attivo. La modifica sarà registrata e visibile al cliente.
      Motivo richiesto.
    </AlertDescription>
  </Alert>
)}
```

### Reason field

```tsx
{wikiLockedAt !== null && (
  <FormField name="reason">
    <Label>Motivo della modifica (richiesto, minimo 10 caratteri)</Label>
    <Textarea rows={3} />
    <FormDescription>
      Sarà visibile al cliente nello storico revisioni.
    </FormDescription>
    <FormMessage />
  </FormField>
)}
```

### Form layout (top to bottom)

1. Banner (BR-062 state).
2. `Description` — textarea, 4 rows, always visible.
3. `Title` — collapsible "Aggiungi titolo personalizzato", expanded if
   `intervention.title` is non-null.
4. `interventionTypeId` — `<Select>` populated from `useInterventionTypes`,
   always visible, pre-selected.
5. `PartsRepeater` — collapsible "Pezzi sostituiti", expanded if any parts
   present.
6. `internalNotes` — collapsible "Note interne", expanded if non-null.
7. `reason` — only when `wikiLockedAt !== null`.
8. Action bar: `[Annulla]` (`variant="ghost"`), `[Salva]` (primary,
   disabled while mutation is in flight).

## Error handling

Exact backend error codes from `interventions-update.ts`:

| HTTP | Backend error code                                       | UI behavior                                                                                              |
| ---- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 400  | `intervention.modification.revision_reason_required`     | Inline error under `reason` field, "Motivo richiesto (almeno 10 caratteri)". Dialog stays open.          |
| 422  | `intervention.modification.cancelled` (BR-130)           | Toast "Intervento cancellato: non modificabile". Close dialog. Invalidate timeline (state shifted).      |
| 422  | `intervention.modification.disputed` (BR-128)            | Toast "Intervento contestato: rispondi alla disputa prima di modificare". Close dialog. Invalidate.     |
| 403  | RLS denial / non-officina principal                      | Toast "Non puoi modificare questo intervento". Close dialog.                                             |
| 404  | RLS-as-404 (P2025 through global handler)                | Toast "Intervento non trovato". Close dialog. Invalidate timeline.                                       |
| 5xx  | Server error / network                                   | Toast "Errore temporaneo, riprova". Dialog stays open. Submit button re-enabled.                         |

Client-side "no changes" guard is handled before any API call (form-level
error rendered top of dialog).

All error toasts are hardcoded Italian copy (consistent with the rest of
the codebase, no i18n module).

## Testing

### Backend

`packages/api/tests/integration/vehicles-timeline.test.ts`:

- Existing "officina lists timeline" scenario: assert `wiki_locked_at` is
  present in the shop-intervention rows and is `null` for fresh rows.
- New scenario: create an intervention with `wikiLockedAt` pre-set via the
  test helper, assert the ISO string surfaces in the API response.

No new handler test, no PATCH-side change.

### Web

`packages/web/src/components/EditInterventionDialog.test.tsx` (~6
scenarios):

1. Mounts with pre-populated values from `intervention` prop.
2. Renders "Modifiche libere" banner when `wikiLockedAt === null`; reason
   field NOT in DOM.
3. Renders "Audit attivo" banner when `wikiLockedAt !== null`; reason
   field in DOM.
4. Submit with 0 changes → form-level error "Nessuna modifica da salvare";
   `mutate` not called.
5. Submit wiki-window with a modified field → `mutate` called with diff
   body (no `reason`), success closes dialog and invalidates the timeline
   query.
6. Submit locked without reason → `setError` on reason field, `mutate`
   not called.
7. Submit returns 422 disputed → toast rendered, `onOpenChange(false)`
   invoked, timeline invalidated.

Radix Dialog mock pattern: apply the lesson from
`feedback_jsdom_radix_select_mock_pattern.md` (module-level mock of the
shadcn Dialog primitives to bypass portal/JSDOM issues, exercising the
form via direct DOM queries inside the rendered children).

`packages/web/src/queries/updateIntervention.test.tsx` (~5 scenarios):

1. Mutation success invalidates `['vehicleTimeline', vehicleId]`.
2. Mutation 400 `intervention.modification.revision_reason_required`
   preserves the code for the consumer.
3. Mutation 422 `intervention.modification.disputed` preserves the code.
4. Mutation 403 bubbles the error.
5. Mutation network failure bubbles a generic error.

`packages/web/src/components/TimelineRow.test.tsx` (3 new scenarios on top
of existing 14):

1. "Modifica" button visible in expanded panel when `status === 'created'`.
2. Button hidden when `status === 'disputed'`.
3. Button hidden when `status === 'cancelled'`.
4. Click on "Modifica" opens `EditInterventionDialog` (verified via the
   dialog component being rendered with `open={true}` prop — use a mock
   of `EditInterventionDialog` at module level to keep the row test
   focused).

`packages/web/src/lib/validators/editIntervention.test.ts` (~3
scenarios):

1. Schema accepts all fields as optional (empty object passes).
2. Schema rejects `title` longer than 200 chars.
3. Schema rejects `description` of length 0 when present.

### Manual smoke (operator-driven, post-deploy)

- Wiki-window happy path: create intervention now, edit immediately,
  expect "Modifiche libere" banner, save without reason, verify timeline
  refetches and shows updated values.
- Locked happy path: locate an intervention where `wiki_locked_at` is
  set (older than 48h or customer has opened it), edit with reason
  ≥10 chars, verify revision row visible to customer.
- Reason missing post-lock: attempt save without reason, expect inline
  error under reason field.
- Disputed block: open dispute for an intervention, attempt edit, expect
  the button to be hidden in the row.
- Cancelled block: cancel an intervention, attempt edit, expect button
  hidden.

## Pre-flight checklist for the implementation plan

Catches the lessons accumulated through PR #82:

1. **RLS topology** — slice C does NOT introduce a new read endpoint on
   the `interventions` table (timeline DTO extension reuses the existing
   `vehicles-timeline` route, which already filters by `vehicleId` and is
   the only consumer). No `findUniqueOrThrow` mirror pattern at risk.
   Confirm in plan.
2. **Error code spelling** — codes are `intervention.modification.cancelled`,
   `intervention.modification.disputed`,
   `intervention.modification.revision_reason_required`. Plan should
   include a grep verification step before the implementer writes the
   mutation hook (lesson from
   `feedback_verify_api_contract_against_backend.md`).
3. **Snake_case mapper** — the timeline endpoint exports `wiki_locked_at`
   in snake_case; the web mapper in `queries/vehicleTimeline.ts` must
   parse it to `Date | null` (consistent with other timestamp fields in
   the same response).
4. **Form errors hidden in collapsed sections** — apply the
   `collectErrorMessages` walker from PR #64 to surface RHF errors in
   `partsReplaced` / `internalNotes` / `reason` even when their parent
   collapsible is collapsed.
5. **Type select reuse** — `useInterventionTypes` lives in
   `packages/web/src/queries/interventionTypes.ts` and is already
   consumed by `pages/InterventionCreate.tsx` and
   `pages/DeadlineDashboard.tsx`. The edit dialog reuses the same hook
   without a new cache key; verify the hook signature returns
   `{ id, code, nameIt }` shape before the dialog implementer task.
6. **AuthContext role gap** — slice does NOT add UI role gating beyond
   the existing officina dashboard route guard. Backend 403 is the
   authoritative fence; the toast copy must be neutral
   ("Non puoi modificare questo intervento") to handle future role drift.

## Estimated size

- Backend: ~3 LOC production + ~10 LOC test + ~5 LOC docs = ~18 LOC.
- Web: ~430 LOC production + ~310 LOC test = ~740 LOC.
- **Total: ~760 LOC.** Above the initial slice C estimate (~300–400 LOC)
  because the design ships parts editing and intervention type editing
  in the same slice (rejected option B = trim was the alternative). Stays
  well below the 1200 LOC alert threshold from
  `feedback_pr_size_tracking.md`.

## Out of scope (followup tickets)

- Revision history view (`GET /v1/interventions/:id/revisions` consumer).
- Edit affordance for `internalNotes` redaction visibility toggles.
- Attachments edit on intervention (separate F-OFF-305 slice).
- AuthContext `role` claim exposure for pre-emptive UI gating.
- Visual countdown of wiki-window remaining time.
- Optimistic concurrency via etag or `updatedAt` watermark.
