# F-CLI-005 PR1 — Notification preferences API (GET/PATCH)

**Date:** 2026-06-08
**Feature:** F-CLI-005 (Gestione notifiche) — backend slice
**Scope:** API only. Mobile UI ships as PR2 (separate spec/plan).
**Type:** additive endpoints, no migration, no deploy, no new dependency.

## What

Two customer-facing endpoints that let a customer read and update their own
notification preferences:

- `GET  /v1/me/notification-preferences`
- `PATCH /v1/me/notification-preferences`

The storage column already exists (`customers.notification_preferences Json
@default("{}")`), the default shape is already defined
(`DEFAULT_NOTIFICATION_PREFERENCES` in `lib/notification-preferences.ts`, BR-226),
and the dispatcher already reads it (`isEmailEnabled`). This slice only adds the
self-service read/write surface.

## Why

- Spec: **F-CLI-005** (`docs/GarageOS-Specifiche.md` §506, MUST) — "Preferenze su
  quali notifiche ricevere e su quali canali".
- Endpoints already reserved in `docs/APPENDICE_A_API.md` §2506-2507.
- Business rules: **BR-226** (default preferences), **BR-260** (some channels are
  always-sent and not disablable), **BR-253** (unsubscribe link points here).

## Editable keys — the core design decision

The stored shape (BR-226) is broader than what is meaningfully editable today.
This slice exposes **only the keys that have a real effect**, to keep the schema
honest (no toggles that do nothing or that BR-260 forbids):

| Key (`email.*`)        | Editable? | Rationale |
|------------------------|-----------|-----------|
| `intervention_updates` | ✅ yes    | Gated by `dispatcher.ts` today |
| `deadline_reminder`    | ✅ yes    | Gated by `dispatcher.ts` today |
| `ownership_transfer`   | ✅ yes    | Gated by `dispatcher.ts` today |
| `marketing`            | ✅ yes    | BR-260 opt-in; canonical unsubscribe toggle; default `false`, zero delivery risk; forward-compatible |
| `transfer_invitation`  | ❌ no     | **BR-260**: always sent, not disablable → exposing it would be a lie |
| `dispute_response`     | ❌ no     | No consumer yet; add via *expand* when a consumer ships |
| `push.*`               | ❌ no     | No delivery yet (F-CLI-302); add via *expand* when push ships |

Excluded keys remain in storage (the signup path writes the full
`DEFAULT_NOTIFICATION_PREFERENCES`); they are simply outside the PATCH schema and
the GET projection. The endpoint schema **expands** in the PR that introduces each
consumer (push → F-CLI-302, dispute → its own slice).

## Architecture

New file `packages/api/src/routes/v1/me-notification-preferences.ts`, registered in
`server.ts`. Exact mirror of `me-profile.ts`:

- preHandler `[requireAuth, requireClientiPool, clientiContext]`.
- **GET** runs under `role:'user'` (the `customers_read` RLS policy is `USING(true)`;
  the app-layer `where:{id:customerId}` scopes to self).
- **PATCH** runs under `role:'admin'` because the `customers` UPDATE policy has no
  `id = current_customer_id()` clause, so a self-update under `role:'user'` is denied
  by RLS. Privacy boundary = explicit `where:{id:customerId}` + Zod strict body.
  Same precedent as `me-profile.ts` PATCH.

### GET contract

Returns the **effective** values (stored prefs deep-merged with defaults, per-key),
so the UI shows correct toggle states even for legacy `{}` rows:

```json
{
  "email": {
    "intervention_updates": true,
    "deadline_reminder": true,
    "ownership_transfer": true,
    "marketing": false
  }
}
```

A new pure function `projectNotificationPreferences(stored: Prisma.JsonValue)` in
`lib/notification-preferences.ts` performs the per-key merge, reusing the same
defensive fallback logic as `isEmailEnabled` (missing / malformed / partial JSON →
default value). Only the 4 editable keys are projected.

### PATCH contract

Body, Zod `.partial().strict()`:

```ts
{ email?: { intervention_updates?: boolean; deadline_reminder?: boolean;
            ownership_transfer?: boolean; marketing?: boolean } }
```

- Unknown top-level key, unknown `email.*` key, or non-boolean value →
  `me.notification-preferences.update.unknown_field` (422). The `.strict()` on both
  the outer object and the nested `email` object produces `unrecognized_keys`, mapped
  to the business error exactly as `me-profile.ts` does.
- Body `{}`, `{email:{}}`, or no editable field → `me.notification-preferences.update.empty_body` (422).

On success: inside `withContext({role:'admin'})`, read the current
`notificationPreferences`, **deep-merge** the supplied `email.<key>` values onto it
(preserving `transfer_invitation`, `dispute_response`, `push.*`), write the merged
JSON back via `customer.update({where:{id:customerId}})`, and return the projected
effective shape (identical to GET). Merge, never replace.

## Error codes (APPENDICE_G)

Added to **both** registries (the table ~§205 and the flat list ~§1005), alphabetical:

| Code | HTTP | Severity | Message | Trigger | Feature |
|---|---|---|---|---|---|
| `me.notification-preferences.update.empty_body` | 422 | info | Nessun campo da aggiornare | PATCH with `{}`, `{email:{}}`, or no editable field | F-CLI-005 |
| `me.notification-preferences.update.unknown_field` | 422 | info | Campo non modificabile | PATCH with a key outside schema (`transfer_invitation`, `push`, `dispute_response`) or a non-boolean value | F-CLI-005, BR-260 |

User-facing messages are Italian (RFC 7807 `detail`).

## Testing

### Integration — `tests/integration/me-notification-preferences.test.ts`

Mirror of `me-profile.test.ts` (auth via `signTestToken` + `createCustomer`).

1. GET on a customer with prefs `{}` → returns the 4 effective defaults
   (`marketing:false`, the rest `true`). Covers merge-from-empty.
2. GET on a customer with a partial override (`{email:{intervention_updates:false}}`)
   → reflects the override; other 3 at defaults.
3. PATCH `{email:{deadline_reminder:false, marketing:true}}` → 200; subsequent GET
   reflects both and preserves untouched keys.
4. **Non-destructive merge:** customer seeded with a FULL prefs object (incl.
   `push.*`, `transfer_invitation`) → PATCH `email.marketing:true` → the DB row still
   contains `push.*` / `transfer_invitation` intact.
5. PATCH `{}` → 422 `…empty_body`.
6. PATCH `{email:{}}` → 422 `…empty_body`.
7. PATCH `{email:{transfer_invitation:true}}` → 422 `…unknown_field` (**BR-260**).
8. PATCH `{push:{...}}` → 422 `…unknown_field`.
9. PATCH `{email:{marketing:"yes"}}` (non-boolean) → 400 (ZodError; `invalid_type` is not `unrecognized_keys`, so it is a validation error, not a business error — consistent with `me-profile.ts`).

### Unit — `tests/unit/routes/v1/me-notification-preferences.test.ts`

FakePrisma (mirror of `me-profile.test.ts`). Required because this is a route-handler
change (typecheck does not catch broken FakePrisma mocks):

- GET projects the merge from defaults.
- PATCH calls `customer.update` under `role:'admin'` with `where:{id}`.
- empty / unknown / non-boolean → business error.

### BR citations in code

`// See BR-226 (default shape) + BR-260 (transfer_invitation always-sent, not editable)`

## Out of scope (deferred)

- Mobile UI (PR2, separate spec).
- `push.*` toggles → F-CLI-302 (push delivery).
- `dispute_response` toggle → ships with its dispatcher consumer.
- Marketing email delivery itself (only the opt-in toggle is stored here).
- Migration / schema change (column already exists).
- Deploy (no infra change).
