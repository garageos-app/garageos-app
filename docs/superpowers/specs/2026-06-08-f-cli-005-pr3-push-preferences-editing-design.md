# F-CLI-005 PR3 — Editing preferenze push per-evento (design)

**Data:** 2026-06-08
**Feature:** F-CLI-005 (preferenze notifiche cliente) — terza e ultima PR, chiude l'arco push F-CLI-302/303.
**Tipo:** cross-layer API + mobile. **NO migration, NO nuova dep, NO deploy nuovo.**

## Contesto

L'arco push è completo lato infrastruttura:

- **PR1 (#173)** — registrazione token (`push_tokens` + endpoint `me-push-tokens`).
- **PR2 (#174)** — delivery: `dispatchNotification` fa fan-out push+email indipendenti (BR-250); `isPushEnabled(customer, key)` gatea il canale push leggendo `notification_preferences.push.<key>` con fallback BR-226 (default `true`).

Manca solo l'ultimo pezzo: **rendere editabili dal cliente le preferenze push per-evento**. Oggi `EDITABLE_EMAIL_KEYS` espone solo le 4 chiavi email; `push.*` resta nello storage ma fuori dalla superficie editabile (commento esplicito in `notification-preferences.ts`). Le chiavi `push.*` esistono già in `DEFAULT_NOTIFICATION_PREFERENCES` (BR-226) e la delivery le rispetta già — questa PR si limita a **sbloccare l'editing**.

## Superficie editabile

`EDITABLE_PUSH_KEYS = ['intervention_updates', 'deadline_reminder', 'ownership_transfer']`

Sono esattamente le 3 chiavi con delivery push reale oggi (`NotificationEventPrefKey`), quelle che `preferenceKeyForEvent` mappa e `isPushEnabled` gatea:

- `intervention_updates` ← `intervention.revised` + `intervention.cancelled`
- `deadline_reminder` ← `deadline.reminder`
- `ownership_transfer` ← `ownership.transferred`

**Escluse** (stesso criterio "solo chiavi con effetto reale" del lato email):

- `push.transfer_invitation` — nessun template push, BR-260 sempre-inviata.
- `push.dispute_response` — nessun consumer.
- Nessun `push.marketing` — non esiste in `DEFAULT_NOTIFICATION_PREFERENCES.push`.

Le chiavi escluse restano nello storage e vengono preservate dal deep-merge.

## Scelta UX (sezione Push)

Schermata mobile `app/notification-preferences.tsx`. Oggi ha:

- **Sezione "Dispositivo"** — toggle device-level che registra/deregistra il token di *questo* device (F-CLI-302).
- **Sezione "Email"** — 4 toggle per-evento.

Si aggiunge una **sezione "Push" sempre visibile**, simmetrica a "Email", con i 3 toggle per-evento + una riga di hint.

Razionale: le preferenze push per-evento sono **account-level** (valgono su ogni device del cliente, persistite in `customer.notification_preferences.push`), quindi semanticamente sensate a prescindere dallo stato del *questo* telefono. Nasconderle/disabilitarle dietro il toggle device-local (che è device-local) sarebbe impreciso. La dissonanza "device OFF ma configuro push" si risolve con un hint testuale, senza accoppiare stato account a stato device. È inoltre il mirror esatto del pattern email già validato in #172.

## Implementazione

### API (`packages/api`)

**`src/lib/notification-preferences.ts`**

- Aggiungere `EDITABLE_PUSH_KEYS = ['intervention_updates', 'deadline_reminder', 'ownership_transfer'] as const` + `type EditablePushKey`.
- `ProjectedNotificationPreferences` diventa `{ email: Record<EditableEmailKey, boolean>; push: Record<EditablePushKey, boolean> }`.
- `projectNotificationPreferences` proietta anche `push`, con lo stesso fallback difensivo (missing/malformed/partial → `DEFAULT_NOTIFICATION_PREFERENCES.push[key]`).

**`src/routes/v1/me-notification-preferences.ts`**

- `editablePushSchema` (mirror di `editableEmailSchema`, su `EDITABLE_PUSH_KEYS`).
- `patchBodySchema = z.object({ email: editableEmailSchema, push: editablePushSchema }).partial().strict()`.
- **empty_body**: contare le chiavi su `email` **+** `push` (oggi conta solo `email`). `{}`, `{email:{}}`, `{push:{}}`, `{email:{},push:{}}` → `422 …empty_body`.
- **deep-merge**: fondere anche `push` sullo `stored.push` preservando le chiavi non-editabili (`transfer_invitation`, `dispute_response`): `merged = { ...stored, email: {...storedEmail, ...email}, push: {...storedPush, ...push} }` (applicando email/push solo quando presenti nel body).
- Codici invariati: unknown key (email o push) → `422 …unknown_field`; valore non-booleano → `400` (ZodError passthrough); GET invariato (ritorna la projection ora con `push`).

### Mobile (`packages/mobile`)

**`src/lib/types/notification-preferences.ts`**

- `EDITABLE_PUSH_KEYS` + `EditablePushKey`; `NotificationPreferences` diventa `{ email: Record<EditableEmailKey, boolean>; push: Record<EditablePushKey, boolean> }`.

**`src/queries/notificationPreferences.ts`**

- `UpdateVars` diventa unione discriminata:
  ```ts
  type UpdateVars =
    | { channel: 'email'; key: EditableEmailKey; value: boolean }
    | { channel: 'push'; key: EditablePushKey; value: boolean };
  ```
- `mutationFn` body: `{ [channel]: { [key]: value } }`.
- ⚠️ **`onMutate` deve preservare l'altro canale**: oggi `setQueryData` scrive `{ email: {...} }` scartando il resto. Diventa `{ ...previous, [channel]: { ...previous[channel], [key]: value } }`. Senza questo fix, un toggle push azzererebbe `email` in cache e viceversa (classe object-setValue-omitted-key).

**`app/notification-preferences.tsx`**

- Nuova sezione "Push" con i 3 toggle (`EDITABLE_PUSH_KEYS`, label IT, `value={push[key]}`, `onValueChange → update.mutate({ channel: 'push', key, value })`).
- I toggle email passano a `channel: 'email'`.
- Riga di hint sotto il titolo Push che chiarisce la dipendenza dal toggle device.
- Label push (3 eventi): "Aggiornamenti interventi", "Promemoria scadenze", "Trasferimenti di proprietà".

### Docs / BR

Nessun nuovo BR né error code (riuso `unknown_field`/`empty_body`). Aggiornare la voce APPENDICE_A dell'endpoint `me/notification-preferences` per notare che `push.*` è ora editabile.

## Test (TDD)

- **API unit** (`tests/unit/lib/notification-preferences.test.ts`): projection include `push` con valori effettivi; fallback difensivo (json mancante/malformato/parziale → default push).
- **API integration** (`tests/integration/me-notification-preferences.test.ts`): PATCH push single-key → 200 + valore aggiornato; deep-merge preserva chiavi email e push non-editabili; unknown push key → 422; body vuoto cross-canale (`{email:{},push:{}}`) → 422; GET ritorna anche push.
- **Mobile** (`tests/screens/notification-preferences*.test.tsx`): render sezione Push (3 toggle); flip toggle push → `update.mutate({ channel:'push', ... })`.
- **Mobile** (`tests/queries/notificationPreferences*.test.ts`): body PATCH per `channel:'push'`; optimistic update preserva l'altro canale (regressione esplicita per il fix `onMutate`).

## Fuori scope

- Smoke push end-to-end (Expo Go): differito a fine arco con `eas init` + `extra.eas.projectId` reale + `EXPO_ACCESS_TOKEN` reale nel secret app.
- Receipt-polling BR-254 (seconda fase): già differito in PR2.
- `push.marketing` / SMS: non esistono ancora come canale/consumer.

## Stima

~7-9 task TDD, cross-layer API+mobile, slice piccola → executing-plans inline + 1 review finale Opus ([[right-size-process-to-task]]).
