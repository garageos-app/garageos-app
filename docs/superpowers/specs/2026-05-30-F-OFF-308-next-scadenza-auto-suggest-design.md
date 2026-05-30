# F-OFF-308 — next-scadenza auto-suggest (web-only)

**Date:** 2026-05-30
**Feature:** F-OFF-308 (docs/GarageOS-Specifiche.md §3.2.4)
**Scope:** Web app (officine) only. No API / DB / CDK changes.

## What

When the operator selects an intervention type that suggests a follow-up
deadline, the intervention-create form proactively opens, enables, and
pre-fills the "Programma scadenza" section from the type's defaults, and
shows a human-readable suggestion line (e.g. *"Suggerito per «Tagliando»:
prossima scadenza tra 15.000 km o 12 mesi."*). The operator can confirm,
customize, or disable.

## Why

F-OFF-308 (🟢 MUST): *"Al salvataggio di un intervento, suggerimento di
creare una scadenza collegata (es. 'prossimo tagliando tra 15.000 km o 12
mesi'). L'officina può confermare o personalizzare."*

The **suggestion** is the missing piece. The rest of F-OFF-308 already ships:

- **Backend** (`packages/api/src/routes/v1/interventions.ts`): `POST
  /v1/vehicles/:id/interventions` accepts `createDeadline`
  (`enabled` / `monthsFromNow` / `kmIncrement`), falls back to the
  intervention type's `suggestsDeadline` / `defaultDeadlineMonths` /
  `defaultDeadlineKm`, and creates the linked deadline with
  `sourceInterventionId` in the same request. BR-080 (deadline auto-create
  is opt-in) is already enforced server-side.
- **Web wire** (`packages/web/src/lib/validators/intervention.ts`): the
  form schema and `transformToPayload` already carry `createDeadline`.
- **Web UI base** (`packages/web/src/components/intervention-form/DeadlineSection.tsx`):
  a collapsible manual section with a switch + "Mesi da oggi" + "Incremento km".

Today the section is **manual and empty**: the operator must open it, flip
the switch, and type the values by hand. The type's `suggestsDeadline` flag
and defaults — already fetched by `useInterventionTypes` — are ignored.

No new business rules. No new endpoints.

## Design decisions (from brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| UX approach | Inline pre-save auto-prefill | One request; reuses existing backend + wire + UI. Avoids a dead second code path (POST /deadlines). |
| Default switch state | **ON (opt-out)** when type suggests | Matches spec "può confermare" — operator confirms or disables. |
| Type change after prefill | **Re-apply new type's defaults** | Predictable: the suggestion always follows the selected type. No dirty-tracking; previous customizations are overwritten. |
| Type suggests but both defaults null | **Do NOT auto-enable** | A switch ON with empty months/km would be a no-op the backend discards; keep it manual instead. |
| i18n | Hardcoded Italian inline | The web app has no i18n library; sibling components (`InterventionForm`, `DeadlineSection`) hardcode Italian. Follow the surrounding pattern. |

## Components

### `InterventionForm.tsx` — suggestion orchestrator

- Already `useWatch`-es `interventionTypeId` and holds `interventionTypes`.
- Add a `useEffect` keyed on `interventionTypeId` that resolves the selected
  `InterventionType` and applies the suggestion:
  - **Suggests** (`suggestsDeadline === true` AND
    (`defaultDeadlineMonths != null` OR `defaultDeadlineKm != null`)):
    - `setShowDeadline(true)`
    - `setValue('createDeadline', { enabled: true, monthsFromNow:
      defaultDeadlineMonths ?? undefined, kmIncrement: defaultDeadlineKm ??
      undefined }, { shouldValidate: false })`
  - **Does not suggest** (or both defaults null, or empty id):
    - `setValue('createDeadline.enabled', false)` — switch OFF. Section stays
      reachable via the manual "▸ Programma scadenza" toggle, as today.
- Compute a `suggestion` object for the selected type and pass it to
  `DeadlineSection` so it can render the hint line:
  `{ typeName, months, km } | null` (null when the type does not suggest).

### `DeadlineSection.tsx` — render the suggestion line

- New optional prop `suggestion?: { typeName: string; months: number | null;
  km: number | null }`.
- When present, render a `text-muted-foreground` line above the inputs:
  - both: *"Suggerito per «{typeName}»: prossima scadenza tra {km} km o
    {months} mesi."*
  - km only: *"Suggerito per «{typeName}»: prossima scadenza tra {km} km."*
  - months only: *"…tra {months} mesi."*
- Numbers formatted with `Intl.NumberFormat('it-IT')` → `15000` → `"15.000"`.
- Inputs continue to bind `createDeadline.monthsFromNow` / `kmIncrement` as
  today; the suggestion line is purely informational.

## Data flow

```
select type
  → useWatch(interventionTypeId) fires
  → useEffect resolves InterventionType from interventionTypes[]
  → if suggests: open section + setValue(createDeadline = {enabled:true, ...defaults})
                 + pass suggestion={typeName,months,km} to DeadlineSection
     else:       setValue(createDeadline.enabled=false), suggestion=null
  → operator confirms / edits / disables
  → submit → transformToPayload sends createDeadline only when enabled
  → existing backend creates linked deadline (sourceInterventionId)
```

## Error handling

- No new error paths. Auto-prefill writes only valid values
  (`positive().optional()`); empty/NaN cases keep the existing top-level
  Alert validation (`collectErrorMessages`).
- Operator may still produce an invalid manual edit (e.g. NaN months); that
  is unchanged and surfaced by the existing validation Alert.

## Testing

`DeadlineSection.test.tsx` (extend):
- renders the suggestion line for all three shapes (both / km-only /
  months-only);
- renders no suggestion line when `suggestion` prop absent;
- existing switch/inputs behavior preserved.

`InterventionForm.test.tsx` (extend):
- selecting a suggesting type → section open + switch ON + values 12 / 15000
  + suggestion line visible;
- selecting a non-suggesting type → switch OFF;
- changing type A→B → values re-applied to B's defaults (overwrite);
- suggesting type with both defaults null → not auto-enabled.

## Out of scope

- Post-save modal / second-request flow (rejected: dead inline path).
- Dirty-tracking to preserve manual edits across type changes (rejected:
  complexity not warranted).
- Any change to the deadline domain, scheduler, or notifications.
- i18n extraction (no i18n system exists in web; tracked separately).

## Estimate

~120–200 LOC including tests. Single PR:
`feat(web): F-OFF-308 next-scadenza auto-suggest`.
