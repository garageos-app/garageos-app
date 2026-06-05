# F-CLI-304 PR2 — Tab "Accessi" mobile (design)

**Data:** 2026-06-05
**Feature:** F-CLI-304 (audit accessi cliente) — PR2 (UI mobile). Completa la UI di **F-CLI-106** (dettaglio veicolo: dati tecnici + storico + scadenze + **audit accessi**).
**Backend:** già shippato in PR1 (#157, `f6e4d11`) — `GET /v1/me/vehicles/:id/access-log` (BR-155 redatto).
**Scope:** solo `packages/mobile`. Zero backend/schema/dipendenze nuove.

## Contesto

Lo screen dettaglio veicolo (`app/(tabs)/vehicles/[id].tsx`) è oggi un `<ScrollView>` con
una barra a 3 tab (Storico / Scadenze / Dati tecnici), ciascun tab reso da un componente
locale che riceve la query in prop e usa `<FlatList scrollEnabled={false}>` per non
collidere con lo ScrollView genitore.

PR1 ha esposto l'endpoint cliente. La response:

```json
{
  "data": [
    {
      "action": "view" | "new_intervention",
      "tenantName": "Officina Rossi",
      "locationCity": "Torino" | null,
      "occurredAt": "2026-06-05T14:32:00.000Z",
      "mechanicName": "Giuseppe Verdi"   // opzionale, solo se esiste customer_tenant_relation (BR-151)
    }
  ],
  "meta": { "has_more": true, "cursor": "<opaco>" }   // cursor presente solo se has_more
}
```

Cursor composito `(createdAt, id)`, ordine `desc`. `view` = un'officina ha consultato lo
storico; `new_intervention` = un'officina ha registrato un intervento. Le registrazioni
veicolo (`vehicle_registered`) sono escluse a monte dall'endpoint. BR-155: mai
`ip`/`userAgent`/id interni.

## Decisioni

| Tema | Scelta | Razionale |
|---|---|---|
| Formato tempo riga | **Relativo + data/ora assoluta sotto** | Feature di trasparenza/sicurezza: leggibilità ("3 giorni fa") + precisione ("05/06/2026 14:32"). Pattern simile a `DeadlineRow` (badge + data). |
| Paginazione | **Infinite scroll** (`useInfiniteQuery`) | L'audit cresce nel tempo (ogni `view` con dedup 30-min + ogni intervento); è l'unico endpoint cliente con cursor realmente utile. |
| Meccanica scroll | **Bottone "Carica altri"** (no `onEndReached`) | Una `FlatList` annidata in `ScrollView` (`scrollEnabled={false}`) non spara `onEndReached`. Il bottone resta dentro la shell esistente: zero refactor del rendering per-tab, rischio minimo di regressioni su Storico/Scadenze/Dati. |
| Caricamento query | **Lazy** (`enabled: tab === 'access'`) | Evita una 4ª network call all'apertura del dettaglio se l'utente non apre la tab. È l'unica consumer dell'endpoint. |
| Label azione | Inline IT (no i18n framework) | Coerente con tutte le slice mobile precedenti (`DeadlineRow`, ecc.). |

## Componenti

### 1. `src/lib/format.ts` — nuovo `formatDateTime`

```
formatDateTime(iso: string | null | undefined): string   // "05/06/2026 14:32"
```

`Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', day/month/year/hour/minute: '2-digit' })`.
Input nullo o data invalida → `'—'`. Timezone esplicita Europe/Rome → deterministico nei test
(DST gestito da `Intl`, indipendente dal device). `formatTimeAgo` riusato as-is per la riga
relativa (granularità giorno: "oggi"/"ieri"/"N giorni fa").

### 2. `src/lib/types/accessLog.ts` — tipi

Mirror della response:

```ts
export type CustomerAccessAction = 'view' | 'new_intervention';

export interface CustomerAccessEntry {
  action: CustomerAccessAction;
  tenantName: string;
  locationCity: string | null;
  occurredAt: string;
  mechanicName?: string;
}

export interface AccessLogPage {
  data: CustomerAccessEntry[];
  meta: { has_more: boolean; cursor?: string };
}
```

### 3. `src/queries/meVehicleAccessLog.ts` — hook

`useMeVehicleAccessLog(vehicleId: string, opts: { enabled: boolean })` con `useInfiniteQuery`:

- queryKey `['me', 'vehicle', vehicleId, 'access-log']`
- queryFn `({ pageParam })`: `GET /v1/me/vehicles/:id/access-log` + `?cursor=<pageParam>` se presente (omesso alla 1ª pagina)
- `initialPageParam: undefined`
- `getNextPageParam: (last) => (last.meta.has_more ? last.meta.cursor : undefined)`
- `select: (data) => data.pages.flatMap((p) => p.data)` → `CustomerAccessEntry[]`
- `enabled` passato da chiamante.

### 4. `src/components/AccessLogRow.tsx` — mirror `DeadlineRow`

Props: `{ entry: CustomerAccessEntry }`. Riga informativa, **non** premibile.

- **body (sinistra)**: label azione (grassetto) → `tenantName` (`· {locationCity}` se non null) → `Tecnico: {mechanicName}` solo se presente.
- **right (destra)**: `formatTimeAgo(occurredAt)` sopra, `formatDateTime(occurredAt)` muted sotto.
- Riusa i token tema esistenti; nessun nuovo colore.

**Label azione (user-facing IT):**

- `view` → **"Consultazione libretto"**
- `new_intervention` → **"Nuovo intervento registrato"**

### 5. `app/(tabs)/vehicles/[id].tsx` — integrazione

- Union tab → `'history' | 'deadlines' | 'tech' | 'access'`; 4° `Pressable` "Accessi" in `tabsRow`.
- `useMeVehicleAccessLog(validId, { enabled: tab === 'access' })` al top-level (hook non condizionale; il gating è via `enabled`).
- `AccessLogTab` (mirror `DeadlinesTab`): stati loading / error (con retry) / empty (`EmptyState` "Nessun accesso registrato"); `FlatList scrollEnabled={false}` di `AccessLogRow`; **footer "Carica altri"** = `Pressable` reso se `hasNextPage`, chiama `fetchNextPage()`, disabilitato/spinner mentre `isFetchingNextPage`.
- `onRefresh`: aggiunge `accessLog.refetch()` al `Promise.all` esistente.

**Nota layout:** 4 tab a `flex: 1` (25% l'una). "Dati tecnici" può andare a capo su schermi stretti come già accade oggi — accettabile, nessun intervento.

## Test (TDD, jest mobile locale)

- `format.test.ts`: `formatDateTime` — UTC→Rome con e senza DST (es. gennaio +01:00, giugno +02:00), input invalido/nullo → `'—'`.
- `AccessLogRow.test.tsx`: label per ciascuna azione; `tenantName` con e senza `locationCity`; `mechanicName` presente/assente; presenza riga relativa + assoluta.
- `meVehicleAccessLog.test.ts`: `getNextPageParam` (has_more true → cursor, false → undefined) + `select` flatten su pagine multiple.
- `[id].test.tsx` (screen): switch sulla tab Accessi rende le righe; bottone "Carica altri" invoca `fetchNextPage`; empty state quando `data` vuoto.

## Fuori scope

- Scroll-to-load (`onEndReached`) — scelto il bottone "Carica altri".
- Azione `vehicle_registered` — esclusa a monte dall'endpoint.
- Navigazione/tap dalla riga di accesso (riga puramente informativa).
- i18n framework — label inline come nelle slice precedenti.

## Pre-flight / gotcha applicabili

- Nessuna **nuova route Expo** → nessun churn di `.expo/types/router.d.ts`.
- Nessuna dipendenza nuova → nessun rischio cluster Expo/Metro/typecheck-strict.
- Endpoint `/me/vehicles/:id/access-log` = **camelCase** (come `/me`, `/me/vehicles`, `/me/deadlines`); i `/me/private-interventions*` restano snake_case.
- `jest` mobile: redirect output a file + loop `grep __EXIT` (l'output-file del background tarda).
- Commit message via file + `git commit -F`; header ≤72, body ≤100; scope `mobile`.
