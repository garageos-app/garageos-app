# F-CLI-302 PR2 — Push delivery (design)

**Data:** 2026-06-08
**Feature:** F-CLI-302/303 (notifiche push), seconda metà dell'arco.
**Prima metà:** PR1 #173 (`b89ed2d`) — registrazione/storage dei push token (`POST`/`DELETE /v1/me/push-tokens`).
**Scope di questa PR:** delivery lato API. Estende `dispatchNotification` con il canale Expo Push accanto all'email.

## Contesto

Lo scheduler scadenze (`processSchedulerInvocation`) e gli eventi intervento
(`interventions-cancel`, `interventions-update`, `vehicles-ownership-transfer`)
già chiamano `dispatchNotification`, oggi **email-only**. La tabella `push_tokens`
(+ RLS `push_tokens_isolation` = `USING(is_admin_role() OR customer_id=current_customer_id())`)
e i default `push.*` in `DEFAULT_NOTIFICATION_PREFERENCES` (BR-226, tutti `true`)
esistono già. Manca solo il canale di consegna.

### Business rules rilevanti

- **BR-250** — le notifiche sono **sempre tentate su entrambi i canali** attivi
  (push + email) se le preferenze lo consentono. Nessun fallback SMS in v1.
- **BR-254** — al fallimento di una push (token invalid/expired riportato da Expo):
  token → `active=false`; se tutti i token del customer diventano inattivi →
  `customer.app_installed=false`.
- **BR-226** — default preferenze: `push.*` tutti `true`. La superficie editabile
  F-CLI-005 NON include ancora `push.*` (→ PR3); in PR2 il push è di fatto sempre
  abilitato salvo override manuale dello storage.
- **BR-157 / BR-040 / BR-064 / BR-066** — create/revise/cancel intervento e
  reminder scadenza generano notifica push+email al customer proprietario.

## Decisioni di scope (confermate)

1. **Solo API delivery.** Nessun listener mobile in questa PR: in background l'OS
   mostra già la notifica (title/body) senza codice app. Foreground-display +
   tap-routing mobile → PR successiva.
2. **Client Expo = `expo-server-sdk`** (dep nuova, giustificata in PR description:
   chunking 100/msg, validazione token, classificazione errori, helper receipt).
3. **BR-254 solo errori ticket-time.** Disattivazione token sugli errori restituiti
   sincronamente dal send (`ticket.status === 'error'` con
   `details.error ∈ {DeviceNotRegistered, InvalidCredentials}`). Il receipt-polling
   asincrono (2ª fase Expo, ~15 min dopo) è **differito** a una PR dedicata.

## Architettura

### Vincolo determinante

- Lo scheduler dispatcha **dentro** la sua `withContext({role:'admin'})` (la dispatch
  guida la macchina a stati `deadline_notifications`).
- I 3 route dispatchano **post-commit** (fuori da qualsiasi tx, con `app` e
  `request.log` in scope).
- Annidare un `withContext` dentro un altro su un connection-pool size-1 (Lambda)
  causerebbe **deadlock**. Quindi il canale push **non deve mai annidare** un nuovo
  contesto dentro la tx dello scheduler.

### Contratto `dispatchNotification`

```ts
dispatchNotification({
  event,        // invariato
  recipient,    // invariato (CustomerForNotification, porta notificationPreferences)
  app,          // NUOVO: { withContext, log } — apre admin ctx quando tx è assente
  tx?,          // NUOVO opzionale: tx admin del chiamante da riusare (solo scheduler)
  logger,       // invariato
}): Promise<DispatchResult>
```

- **Scheduler** passa `tx` (la sua tx admin) → il canale push riusa quella tx per
  leggere/scrivere `push_tokens`; l'HTTP Expo finisce dentro la tx, **esattamente
  come fa già `sendEmail` oggi** (nessun pattern nuovo introdotto).
- **Route** passano `app` e omettono `tx` → il canale push apre il **proprio**
  `withContext({role:'admin'})` breve (pool libero post-commit → nessun deadlock).

Il contratto "**`dispatchNotification` non lancia mai**" resta invariato: ogni
errore push viene catturato e loggato, mai propagato. Push e email sono
**indipendenti**: il fallimento di uno non impedisce l'altro.

### Risultato (`DispatchResult`) — push additiva, back-compat

```ts
interface DispatchResult {
  sent: boolean;                              // EMAIL — semantica INVARIATA
  skipped?: 'pref-off' | 'no-recipient' | 'invalid-email';  // EMAIL — invariato
  error?: string;                             // EMAIL — invariato
  push?: PushDispatchResult;                  // NUOVO — solo logging, best-effort
}

interface PushDispatchResult {
  attempted: number;          // token attivi su cui si è tentato
  sent: number;               // ticket ok
  skipped?: 'pref-off' | 'no-token';
  deactivated: number;        // token disattivati (BR-254)
  appInstalledCleared: boolean; // true se app_installed → false
  error?: string;             // errore di canale (es. invio Expo fallito in blocco)
}
```

Lo scheduler continua a derivare `delivery_status` **solo da `sent`/`skipped`
(email)**. Il push non altera la macchina a stati: è best-effort e loggato a parte.
Blast radius minimo.

### Canale push — `lib/notifications/push-channel.ts` (nuovo)

Firma: `dispatchPush({ tokenCtx, recipient, event, logger }): Promise<PushDispatchResult>`
dove `tokenCtx` è `tx ?? (cb) => app.withContext({role:'admin'}, cb)`.

Passi:
1. **Gating preferenza**: `isPushEnabled(recipient, preferenceKeyForEvent(event))`
   (mirror di `isEmailEnabled`, legge `push.<key>`, default BR-226). Off → `skipped:'pref-off'`.
2. **Load token attivi**: `pushToken.findMany({ where:{ customerId: recipient.id, active:true } })`.
   Nessuno → `skipped:'no-token'`.
3. **Render payload** dai template push (vedi sotto).
4. **Invio Expo** via `expo-server-sdk`: `Expo.chunkPushNotifications` +
   `expo.sendPushNotificationsAsync`. `new Expo({ accessToken: process.env.EXPO_ACCESS_TOKEN })`
   (assente = invio standard). Token non-Expo filtrati con `Expo.isExpoPushToken`
   (difesa in profondità; la regex di registrazione già li valida).
5. **BR-254**: per ogni ticket `status:'error'` con
   `details.error ∈ {DeviceNotRegistered, InvalidCredentials}` → `update active:false`
   sul token corrispondente (allineamento per indice ticket↔token preservando l'ordine
   dei chunk). Poi ricontrolla i token attivi del customer: se 0 → `customer.update app_installed:false`.

L'invio HTTP Expo è isolato: per i route avviene dentro un admin ctx breve; per lo
scheduler dentro la tx esistente. La classificazione errori avviene sui ticket
sincroni (no receipt-polling).

### Template push — `lib/notifications/templates/push/*` (nuovi)

Funzioni pure title+body IT brevi per i 4 eventi (mirror dei subject email),
DB-free, unit-testabili. Ogni payload include
`data: { type, vehicleId?, deadlineId?, interventionId? }` per il tap-routing futuro
(non consumato in PR2). Stessa mappatura evento→chiave di `preferenceKeyForEvent`.

| Evento | Pref key | Title (esempio) | data |
|---|---|---|---|
| `intervention.revised` | `intervention_updates` | "Intervento aggiornato" | `{type:'intervention.revised', interventionId, vehicleId}` |
| `intervention.cancelled` | `intervention_updates` | "Intervento annullato" | `{type:'intervention.cancelled', interventionId, vehicleId}` |
| `deadline.reminder` | `deadline_reminder` | "Scadenza in arrivo" | `{type:'deadline.reminder', deadlineId, vehicleId}` |
| `ownership.transferred` | `ownership_transfer` | "Veicolo trasferito" | `{type:'ownership.transferred', vehicleId}` |

I testi finali sono in italiano, brevi (title ≤ ~40 char, body ≤ ~120), allineati
ai template email esistenti.

### `isPushEnabled` — `lib/notifications/preferences.ts`

Aggiunta sibling di `isEmailEnabled`: stessa fallback difensiva (missing/malformed/partial
→ default BR-226), legge `prefs.push[key]`. La mappa evento→chiave già esiste
(`preferenceKeyForEvent` ritorna `intervention_updates | deadline_reminder | ownership_transfer`,
chiavi presenti sia in `email` che in `push` dei default).

## Call-site (modifiche)

| File | Modifica |
|---|---|
| `lib/deadlines/scheduler-invocation.ts` | Passa `app` + `tx` all'input dispatch (dispatch resta dentro la tx admin). |
| `routes/v1/interventions-cancel.ts` | Passa `app` all'input dispatch (post-commit, no tx). |
| `routes/v1/interventions-update.ts` | idem |
| `routes/v1/vehicles-ownership-transfer.ts` | idem |

Nessun call-site sposta logica di business né cambia la posizione della dispatch.

## Testing

### Unit (Jest, Expo mockato)
- `push-channel`: ticket tutti ok (`attempted/sent`); `DeviceNotRegistered` →
  `deactivated` + `update active:false`; tutti i token disattivati → `app_installed=false`
  + `appInstalledCleared:true`; `no-token`; `pref-off`; errore di invio in blocco → `error`.
- `isPushEnabled`: default, override true/false, json malformato.
- template push: render title/body/data per i 4 eventi.
- `dispatcher`: fan-out indipendente — email ok + push pref-off, push ok + email
  pref-off, entrambi, entrambi off. Verifica che un throw del canale push **non**
  alteri il risultato email e che `push` sia popolato.

### Integration (Postgres reale, Expo mockato)
- token attivi seedati → letti sotto admin ctx; `DeviceNotRegistered` persiste
  `active=false` su DB; ultimo token → `app_installed=false`.
- RLS: la lettura `push_tokens` funziona sotto `role:'admin'`; sanity che un
  contesto tenant NON la vedrebbe (motivazione del riuso tx admin / own ctx).
- scheduler end-to-end: deadline reminder → email + push, `delivery_status`
  derivato dall'email, `push` loggato.

I test che asseriscono la firma dell'input di `dispatchNotification` (mock FakePrisma
/ `.mock.calls`) vanno aggiornati per i nuovi campi `app`/`tx` (lezione
handler-change-breaks-unit-mock).

## Dipendenze, migration, deploy

- **Dep nuova**: `expo-server-sdk` (in `packages/api`). Giustificata in PR description.
- **Nessuna migration** (`push_tokens` + RLS già nell'init).
- **Deploy**: solo CDK/app (nessun `prisma migrate`). `EXPO_ACCESS_TOKEN` env
  **opzionale** (assente = invio Expo standard); se in futuro si abilita "Enhanced
  Security for Push Notifications" su Expo, va iniettato via secret — fuori scope PR2.
- **Smoke push DIFFERITO** a fine arco (dopo PR3 toggle), insieme a `eas init` +
  `extra.eas.projectId` reale in `app.json`. Non si fanno smoke parziali di PR2.

## Out of scope (PR successive)

- Receipt-polling asincrono Expo (copertura BR-254 completa su delivery reale).
- Listener/foreground-display + tap-routing mobile.
- PR3: sblocco toggle `push.*` nella superficie editabile F-CLI-005.
- Rate limiting / digest (BR-251), silenzio notturno (BR-255) — roadmap v1.1.
