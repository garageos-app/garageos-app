# Tag button status gate — design

**Data:** 2026-05-31
**Slice:** #6 tag-button status gate (bugfix UI, follow-up #130/#131)
**Tipo:** behavior-change frontend-only
**BR rilevante:** BR-026 (tag PDF disponibile solo per veicoli `certified`)

## Problema

In `packages/web/src/pages/VehicleDetail.tsx:107` il componente `VehicleTagPrintButton`
è renderizzato **sempre**, senza considerare `vehicle.status`. Il backend
(`packages/api/src/routes/v1/vehicles-tag.ts`) consente il tag **solo per veicoli
`certified`**:

- `archived` → `409 vehicle.archived`
- `pending` (o qualsiasi stato non-certified) → `409 vehicle.not_certified`
- `certified` → `200`

Conseguenza: su un veicolo `pending` o `archived` l'operatore clicca "Stampa tag" e
riceve l'errore **solo dopo il click** (round-trip + messaggio inline). UX scadente:
la regola di stato è nota lato client (`vehicle.status` è già disponibile nella pagina)
ma non viene usata per prevenire l'azione.

## Precedenti nella stessa pagina

`VehicleDetail.tsx` già applica gate di stato ad altri due button:

- **"Registra intervento"** → visibile ma `disabled` quando `archived`.
- **"Trasferisci proprietà"** → nascosto se non `certified`.

Questo design segue il pattern **disabled-visibile** (come "Registra intervento"),
scelto in fase di brainstorming.

## Decisione di design

Il button "Stampa/Ristampa tag" resta **sempre visibile** ma viene **disabilitato**
quando `vehicle.status !== 'certified'`, con un testo-motivo sotto il button:

| status | button | testo-motivo |
|---|---|---|
| `certified` | abilitato (comportamento attuale) | — |
| `archived` | disabled | "Non disponibile per veicoli archiviati" |
| `pending` (e ogni altro non-certified) | disabled | "Disponibile dopo la certificazione" |

Il guard è **positivo** (`status !== 'certified'`), coerente col backend: qualsiasi
stato futuro non-certified ricade nel ramo "Disponibile dopo la certificazione",
mentre `archived` ha la sua copy specifica.

## Componenti

### `VehicleTagPrintButton` (modificato)

- Nuova prop `status: VehicleStatus` (`'pending' | 'certified' | 'archived'`).
- `const disabledByStatus = status !== 'certified'`.
- `disabled={disabledByStatus || mutation.isPending}`.
- Quando `disabledByStatus`, `handleClick` non si attiva (button disabled) → nessuna
  mutation, nessuna apertura del `VehicleTagReprintDialog`, nessuna richiesta al backend.
- La logica esistente `isReprint` / `label` resta invariata: un veicolo con tag già
  stampato ma poi `archived` mostra comunque "Ristampa tag", ma disabilitato con motivo.
  (label = funzione disponibile; disabled = stato corrente).
- **Testo-motivo:** `<p>` statico con un `id` univoco, referenziato da `aria-describedby`
  sul button. NON usa `role="alert"` (riservato al messaggio d'errore post-click).
  Occupa lo stesso slot absolute-positioned dell'errore per non alterare l'altezza della
  action row.

### `VehicleDetail.tsx` (modificato)

- Passa `status={v.status}` al `VehicleTagPrintButton` (riga ~107). Una riga.

### Difesa in profondità (invariata)

- Il guard di stato nel backend (`vehicles-tag.ts`) e `mapTagError` nel componente
  **restano**: coprono la race "veicolo `certified` al load → diventa `archived` o
  trasferito prima del click". Se mai partisse una richiesta, l'errore inline è il
  fallback. Il gate client-side è un'ottimizzazione UX, non l'unica linea di difesa.

## Data flow

`VehicleDetail` ha già `v.status` da `GET /v1/vehicles/:id` → lo passa al button →
il button calcola `disabledByStatus` localmente. Nessuna nuova query, nessun nuovo
campo API.

## Error handling

- Click su button disabled: impossibile (HTML `disabled`). Nessun errore.
- Race certified→archived: backend 409 → `mapTagError` → messaggio inline esistente.

## Testing

### Unit (frontend)

`VehicleTagPrintButton.test.tsx`:
- `status='pending'` → button disabled + testo "Disponibile dopo la certificazione".
- `status='archived'` → button disabled + testo "Non disponibile per veicoli archiviati".
- `status='certified'`, `tagFirstPrintedAt=null` → abilitato, label "Stampa tag".
- `status='certified'`, `tagFirstPrintedAt!=null` → abilitato, label "Ristampa tag".
- click su button disabled (`pending`/`archived`) → la mutation NON parte e il dialog
  di ristampa NON si apre.

`VehicleDetail.test.tsx`:
- aggiornare solo se asserisce sulle props passate al button.

### Smoke (manuale, leggero)

Su un veicolo per ciascuno stato:
- `pending` → button disabled + "Disponibile dopo la certificazione".
- `archived` → button disabled + "Non disponibile per veicoli archiviati".
- `certified` → button abilitato; "Stampa tag" / "Ristampa tag" funzionante come oggi.

## Fuori scope

- Nessuna modifica al backend, allo schema, all'API o ai BR.
- Nessun cambiamento al `VehicleTagReprintDialog`.
- Nessun tooltip on-hover aggiuntivo oltre al testo-motivo (YAGNI).

## Dimensione stimata

~100-140 LOC inclusi i test. Slice piccola → processo right-sized: niente pipeline
subagent multi-stadio, una sola review finale.
