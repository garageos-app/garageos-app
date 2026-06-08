# F-CLI-005 PR2 — Schermata mobile preferenze notifiche

**Data:** 2026-06-08
**Feature:** F-CLI-005 (preferenze notifiche cliente)
**Scope:** mobile-only (consumer della API shippata in PR1 #171)
**Dipendenze:** F-CLI-005 PR1 (`GET/PATCH /v1/me/notification-preferences`, merged in `e324f2d`)

## What

Schermata React Native (Expo) che permette al cliente B2C di vedere e modificare le proprie
preferenze di notifica email. Consuma `data.email.*` esposto dall'endpoint PR1. Quattro toggle
editabili, salvataggio per-toggle istantaneo con optimistic update.

## Why

PR1 ha shippato il backend (`GET/PATCH /v1/me/notification-preferences`) ma senza consumer:
la superficie editabile non è raggiungibile da nessuna UI. Questa PR chiude il filone lato
cliente fornendo la schermata di gestione.

Riferimenti business:
- **BR-226** — shape di default delle preferenze notifiche (4 chiavi email editabili + altre
  non editabili). La API è l'unica sorgente di verità dello shape.
- **BR-260** — `transfer_invitation` è sempre inviata e NON disabilitabile: non compare come
  toggle. Un hint testuale lo comunica all'utente.

Superficie editabile (= `EDITABLE_EMAIL_KEYS` lato API):
`intervention_updates`, `deadline_reminder`, `ownership_transfer`, `marketing`.
Escluse dall'editing (restano in storage, fuori dalla UI): `transfer_invitation` (BR-260),
`dispute_response` (nessun consumer), `push.*` (nessuna delivery — F-CLI-302 futura).

## Non-goals (YAGNI)

- Nessun toggle per i canali `push.*` (delivery non esiste ancora — F-CLI-302).
- Nessun toggle per `transfer_invitation` / `dispute_response`.
- Nessuna modifica API, infra, schema DB, o dipendenze npm.
- Nessuna nuova entry nella tab bar (la schermata è secondaria, raggiunta da Profilo).

## Wire shape (dalla API PR1)

`GET /v1/me/notification-preferences` → `200`:

```json
{ "email": { "intervention_updates": true, "deadline_reminder": true,
             "ownership_transfer": true, "marketing": false } }
```

`PATCH /v1/me/notification-preferences` body (deep-merge non-distruttivo, una sola chiave OK):

```json
{ "email": { "marketing": true } }
```

Risposta PATCH: stesso shape della GET (valori effettivi proiettati).

## Architettura e file

Mirror dei pattern mobile esistenti (`me.ts` query + `profile.tsx` schermata + `claim-vehicle.tsx`
route standalone).

| File | Tipo | Scopo |
|---|---|---|
| `packages/mobile/src/lib/types/notification-preferences.ts` | nuovo | `EditableEmailKey` union + `NotificationPreferences = { email: Record<EditableEmailKey, boolean> }` + body type |
| `packages/mobile/src/queries/notificationPreferences.ts` | nuovo | `useNotificationPreferences()` (GET) + `useUpdateNotificationPreference()` (PATCH optimistic) |
| `packages/mobile/app/notification-preferences.tsx` | nuovo | schermata: 4 toggle, stati loading/error, header inline |
| `packages/mobile/app/(tabs)/profile.tsx` | modifica | riga "Notifiche" → `router.push('/notification-preferences')` |
| `packages/mobile/tests/screens/notification-preferences.test.tsx` | nuovo | test schermata (render, optimistic, revert, error) |

**Nessuna modifica a `app/_layout.tsx`:** lo Stack root ha `headerShown: false`; la schermata
imposta il proprio header inline via `<Stack.Screen options={{ headerShown: true, title: 'Notifiche' }} />`,
identico a `claim-vehicle.tsx`. Expo Router registra la route top-level automaticamente dal
filesystem.

**Route top-level standalone** (non sotto `(tabs)`): evita la collisione di segmento nota
(plan/route Expo dentro un group dir) — mirror di `app/claim-vehicle.tsx`.

## Data layer — `src/queries/notificationPreferences.ts`

```
queryKey: ['me', 'notification-preferences']
```

`useNotificationPreferences()`:
- `useQuery<NotificationPreferences, Error>` → `api.fetch('/v1/me/notification-preferences')`.
- Eredita retry/staleTime dal QueryClient root.

`useUpdateNotificationPreference()` — `useMutation`, input `{ key: EditableEmailKey, value: boolean }`:
- `mutationFn`: `api.fetch('/v1/me/notification-preferences', { method: 'PATCH', body: { email: { [key]: value } } })`.
- `onMutate({ key, value })`:
  1. `await qc.cancelQueries({ queryKey })` — annulla refetch in volo.
  2. `previous = qc.getQueryData(queryKey)` — snapshot.
  3. `qc.setQueryData(queryKey, prev => ({ email: { ...prev.email, [key]: value } }))`.
  4. `return { previous }`.
- `onError(_err, _vars, ctx)`: `if (ctx?.previous) qc.setQueryData(queryKey, ctx.previous)` — revert.
- `onSettled()`: `qc.invalidateQueries({ queryKey })` — riconcilia con il server.

**Race su tap rapidi:** `cancelQueries` in `onMutate` annulla i refetch pendenti; ogni mutation
snapshotta lo stato immediatamente precedente, quindi tap consecutivi si applicano in ordine
e l'`invalidate` finale riallinea alla verità del server. Il deep-merge lato API garantisce
che PATCH di chiavi diverse non si sovrascrivano a vicenda.

## Schermata — `app/notification-preferences.tsx`

- Header: `<Stack.Screen options={{ headerShown: true, title: 'Notifiche' }} />` (back automatico
  dallo Stack).
- Stati:
  - `isLoading` → `<LoadingState variant="fullscreen" />`.
  - `isError` → `<ErrorState message={mapErrorToUserMessage(code)} onRetry={refetch} />`
    (`code` = `error.code` se `ApiError`, altrimenti `undefined`).
- Corpo: `ScrollView` con 4 righe. Ogni riga: `View` con `Text` (label) + `Switch` (RN core).
  - `value` = `data.email[key]`.
  - `onValueChange={(v) => update.mutate({ key, value: v })}`.
- Mapping label → IT:
  | key | label |
  |---|---|
  | `intervention_updates` | Aggiornamenti interventi |
  | `deadline_reminder` | Promemoria scadenze |
  | `ownership_transfer` | Trasferimenti di proprietà |
  | `marketing` | Novità e promozioni |
- Footer hint (BR-260): testo `muted` tipo «Alcune comunicazioni di servizio (es. inviti al
  trasferimento di un veicolo) vengono sempre inviate.» — così l'assenza del toggle è spiegata.
- Stile: riusa `colors`/`spacing` da `@/theme/colors` e il pattern `card` di `profile.tsx`.

L'ordine delle righe segue `EDITABLE_EMAIL_KEYS` (un array locale che mirra l'ordine API),
così l'output è deterministico e testabile.

## Entry point — `app/(tabs)/profile.tsx`

Nuova `Pressable` "card" (stile `styles.card` esistente) inserita tra le card dati e il bottone
"Esci":
- Label "Notifiche" + chevron (`Ionicons` `chevron-forward`, già usato altrove).
- `onPress={() => router.push('/notification-preferences')}`.
- Aggiungere `useRouter` da `expo-router` agli import.

## Error handling

- GET fallito → `ErrorState` con retry (pattern Profilo).
- PATCH fallito → revert optimistic (toggle torna al valore precedente). Niente alert bloccante:
  il revert è il feedback. (Coerente con UX settings; l'utente può ritentare il tap.)
- Tutti i codici errore passano per `mapErrorToUserMessage`; nessun nuovo codice domain atteso
  (l'endpoint usa `422` per body invalidi che la UI non può produrre, dato che manda sempre una
  chiave valida).

## Testing — `tests/screens/notification-preferences.test.tsx`

Mirror degli screen test esistenti: mock `expo-router`, wrapper `QueryClientProvider`, mock
del fetch/api-client.

Casi:
1. **Render** — con GET mockato che ritorna i 4 valori, i 4 `Switch` mostrano lo stato corretto.
2. **Optimistic flip** — flip di un toggle chiama PATCH con `{ email: { <key>: <nuovo valore> } }`
   e la UI riflette subito il nuovo valore.
3. **Revert su errore** — PATCH rigetta → il toggle torna al valore precedente.
4. **Error state** — GET fallisce → `ErrorState` reso.

Il data layer optimistic è coperto via screen test; nessun file di test query separato salvo
serva isolare un caso.

## Verifica locale

- `pnpm -r typecheck` (pre-push hook). Nuova route Expo → rimuovere `.expo/types/router.d.ts`
  prima del typecheck così i tipi route si rigenerano (gotcha noto).
- `pnpm --filter @garageos/mobile test` per lo screen test.
- Smoke device opzionale (Metro `expo start --offline` + `adb reverse tcp:8081`).

## Rischi / note

- **Cold start Lambda ~10s** (accettato in fase demo): l'optimistic update fa rispondere la UI
  all'istante mentre il PATCH viaggia in background, quindi la latenza non è percepita salvo nel
  caso di revert (raro). È la ragione principale per cui si è scelto per-toggle optimistic invece
  di edit/Salva batch.
- **Mock api-error mobile** deve mirrorare l'envelope RFC7807 reale (`code`/`detail`) — gotcha
  ricorrente: i test devono usare lo shape vero, non inventato.
- Fallback se l'optimistic risultasse troppo pesante in review: edit/Salva batch (mirror
  `ProfileForm`), a basso rischio. Non previsto, ma documentato.
