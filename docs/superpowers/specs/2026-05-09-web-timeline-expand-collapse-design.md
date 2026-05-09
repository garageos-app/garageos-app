# Design — Web timeline expand/collapse con dettaglio inline

**Date:** 2026-05-09
**Type:** Frontend (web app officina), zero backend changes
**LOC budget:** ~355 net (130 prod + 230 test − 5 modifiche minori)
**Drives:** primo vertical slice post pivot agile (vedi `project_resume_checkpoint.md` §"Lessons learned cycle PR #78"). Surfacia i campi `description`, `parts_replaced_count`, `attachments_count`, `is_disputed` che oggi sono nel timeline DTO ma invisibili dall'UI.
**Backend prerequisiti:** già live — `GET /v1/vehicles/:id/timeline` shipped + consumed da `useVehicleTimeline`.

## 1. Why

`VehicleDetail.tsx` mostra già una timeline interventi compatta (data | titolo | subtitle | km | badge), ma 4 campi importanti del DTO `TimelineItem` sono mai mostrati: `description`, `parts_replaced_count`, `has_attachments`/`attachments_count`, `is_disputed`. Per la persona A Giuseppe officina, questi campi sono il valore quotidiano:

- **description**: cosa è stato effettivamente fatto. Senza è solo una lista di tipi.
- **parts_replaced_count**: quanti ricambi sostituiti, indica complessità intervento.
- **has_attachments**: foto/fatture allegate, valore di provenance.
- **is_disputed**: BR-129 — un'intervento contestato richiede attenzione immediata. Oggi invisibile.

Questo slice **non aggiunge feature**, **rivela** quelle già implementate API-side. È il pattern paradigmatico del vertical slicing post-pivot: API matura → UI surface → demo immediato → feedback cliente immediato.

## 2. Architecture

### 2.1 Refactoring

Estrai la riga timeline da `VehicleDetail.tsx` (linee 169-194 attuali) in un nuovo componente `TimelineRow.tsx` autonomo e testabile. `VehicleDetail.tsx` torna page coordinator: mappa `timelineItems` → `<TimelineRow item={...} />`.

### 2.2 Componente shape

```
TimelineRow ({ item }: { item: TimelineItem })
  └─ useState<boolean>(false) per expanded
  └─ <button type="button" aria-expanded aria-controls={panelId} onClick={toggle}>
       ├─ DateColumn      formatDate(intervention_date)
       ├─ MainColumn
       │   ├─ Title       item.title ?? type.name_it (shop) | custom_type ?? 'Intervento privato'
       │   └─ Subtitle    `${tenant.business_name} · ${city} · ${formatKm(odometer)}` (shop)
       │                  | `Cliente · ${formatKm(odometer)}` (private)
       ├─ DisputeBadge    badge rosso 'Disputa' se item.kind === 'shop_intervention' && item.is_disputed
       ├─ KindBadge       'Officina' | 'Privato'
       └─ ChevronIcon     rotate 180° quando expanded
     </button>
  └─ <div id={panelId} className="grid grid-rows-[0fr]/[1fr] transition-all">
       └─ <div className="overflow-hidden">
            ├─ Divider sottile
            ├─ Description (testo full o "Nessuna descrizione." italic muted se vuoto)
            └─ MetaBadges row:
                ├─ "{n} ricambi" se shop && parts_replaced_count > 0
                └─ "Con allegati ({n})" se has_attachments && attachments_count > 0
```

### 2.3 Multi-open accordion

Ogni `TimelineRow` ha state locale `expanded` separato. Più righe possono essere aperte simultaneamente. Niente coordinamento globale — accettato per consultazione 2-3 interventi paralleli (es. operatore confronta tagliandi precedenti).

### 2.4 Animazione expand/collapse

Pattern Tailwind grid-rows che permette transizione altezza variabile senza misurazione JS:

```tsx
<div
  id={panelId}
  className={cn(
    'grid transition-all duration-200 ease-out',
    expanded ? 'grid-rows-[1fr] opacity-100 mt-3 pt-3 border-t' : 'grid-rows-[0fr] opacity-0',
  )}
>
  <div className="overflow-hidden">
    {/* expanded content */}
  </div>
</div>
```

Chevron rotation:

```tsx
<ChevronDown size={16} className={cn('transition-transform', expanded && 'rotate-180')} />
```

### 2.5 Accessibility

- `<button type="button" aria-expanded={expanded} aria-controls={panelId}>` per toggle
- `panelId = useId()` (React 18+ hook) per ARIA wiring
- Keyboard `Enter`/`Space` aprono/chiudono nativamente (è un button)
- Focus visible mantenuto (Tailwind `focus-visible:ring-2`)

## 3. Files

### 3.1 NEW

| File | Purpose | LOC |
|---|---|---|
| `packages/web/src/components/TimelineRow.tsx` | Riga + pannello espandibile, props `{ item: TimelineItem }` | ~130 |
| `packages/web/src/components/TimelineRow.test.tsx` | Component test (10 scenari) | ~150 |
| `packages/web/src/pages/VehicleDetail.test.tsx` | Page integration test (5 scenari) | ~80 |

### 3.2 MODIFIED

| File | Change | LOC |
|---|---|---|
| `packages/web/src/pages/VehicleDetail.tsx` | Sostituisci inline timeline rendering con `<TimelineRow item={item} />` | net ~−5 (-30 / +25) |

### 3.3 Module shapes

**`TimelineRow.tsx` skeleton**:

```tsx
import { useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';

import { cn } from '@/lib/utils';
import { fallback, formatDate, formatKm } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import type { TimelineItem } from '@/queries/types';

// Timeline row con expand/collapse inline. Surfacia description,
// parts_replaced_count, attachments, is_disputed che il DTO timeline
// già contiene ma il rendering compact non mostrava.
//
// Multi-open accordion: ogni riga ha state locale, niente coordinamento.
// Animazione via Tailwind grid-rows trick (no JS measure).

interface Props {
  item: TimelineItem;
}

export function TimelineRow({ item }: Props) {
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();

  const isShop = item.kind === 'shop_intervention';
  const title = isShop
    ? (item.title ?? item.type.name_it)
    : (item.custom_type ?? 'Intervento privato');
  const subtitle = isShop
    ? `${item.tenant.business_name}${item.tenant.location_city ? ' · ' + item.tenant.location_city : ''}`
    : 'Cliente';
  const isDisputed = isShop && item.is_disputed;

  return (
    <div className="px-4 py-3">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
      >
        <div className="text-xs text-muted-foreground w-24 shrink-0">
          {formatDate(item.intervention_date)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm text-foreground truncate">{fallback(title)}</div>
          <div className="text-xs text-muted-foreground truncate">
            {subtitle} · {formatKm(item.odometer_km)}
          </div>
        </div>
        {isDisputed && (
          <Badge variant="destructive" className="text-[10px]">
            Disputa
          </Badge>
        )}
        <Badge variant="outline" className="text-[10px]">
          {isShop ? 'Officina' : 'Privato'}
        </Badge>
        <ChevronDown
          size={16}
          className={cn('text-muted-foreground transition-transform', expanded && 'rotate-180')}
        />
      </button>

      <div
        id={panelId}
        className={cn(
          'grid transition-all duration-200 ease-out',
          expanded ? 'grid-rows-[1fr] opacity-100 mt-3 pt-3 border-t' : 'grid-rows-[0fr] opacity-0',
        )}
      >
        <div className="overflow-hidden">
          <ExpandedPanel item={item} />
        </div>
      </div>
    </div>
  );
}

function ExpandedPanel({ item }: { item: TimelineItem }) {
  const description = item.description?.trim();
  const isShop = item.kind === 'shop_intervention';
  const partsCount = isShop ? item.parts_replaced_count : 0;
  const hasAttachments = item.has_attachments && item.attachments_count > 0;

  return (
    <div className="space-y-3 pl-28">
      {description ? (
        <p className="text-sm text-foreground leading-relaxed whitespace-pre-line">{description}</p>
      ) : (
        <p className="text-sm italic text-muted-foreground">Nessuna descrizione.</p>
      )}
      {(partsCount > 0 || hasAttachments) && (
        <div className="flex flex-wrap gap-2">
          {partsCount > 0 && (
            <Badge variant="secondary" className="text-[11px]">
              {partsCount} ricambi
            </Badge>
          )}
          {hasAttachments && (
            <Badge variant="secondary" className="text-[11px]">
              Con allegati ({item.attachments_count})
            </Badge>
          )}
        </div>
      )}
    </div>
  );
}
```

**`VehicleDetail.tsx` modification**: sostituisci il blocco mappa items (lines 169-194) con:

```tsx
<div className="bg-card border border-border rounded-lg divide-y divide-border">
  {timelineItems.map((item) => (
    <TimelineRow key={item.id} item={item} />
  ))}
</div>
```

(+ import `TimelineRow` from `@/components/TimelineRow`)

## 4. Edge cases

| Caso | Handling |
|---|---|
| `description` vuoto / undefined | Pannello mostra "Nessuna descrizione." in muted-foreground italic |
| `parts_replaced_count === 0` | Niente badge ricambi (silenzio) |
| `attachments_count === 0` ma `has_attachments === true` | Edge case improbabile, comunque non mostra badge (`hasAttachments` controlla entrambi) |
| `attachments_count > 0` | Badge "Con allegati (3)" con count |
| Private con `description` lungo | Wrap text naturale (whitespace-pre-line), pannello cresce in altezza |
| Tutti collapsed al primo render | Default `expanded=false` per ogni riga |
| Refresh page | State perso (in-memory), tutti collassati. Accettato YAGNI |
| Shop con `is_disputed=true` | Badge "Disputa" rosso visible in compact, niente extra in expanded v1 |
| Click su button durante animation | Re-toggle pulito, no glitch (transition gestita da grid-rows) |
| Description con newlines | `whitespace-pre-line` rispetta `\n` come line break |

## 5. Test plan

### 5.1 `TimelineRow.test.tsx` (jsdom + RTL, ~150 LOC)

Fixture base shop intervention + private intervention.

1. **Render compact shop**: mostra date, title, subtitle, badge "Officina", chevron giù; description NON visibile (collapsed)
2. **Render compact private**: mostra "Privato" badge, custom_type come titolo
3. **Dispute badge visible in compact** quando `is_disputed=true` (shop)
4. **Dispute badge absent in compact** quando `is_disputed=false`
5. **Dispute badge ALWAYS absent for private**: anche se private items non hanno is_disputed nel type, never render
6. **Click sulla riga** → `aria-expanded="true"`; description visibile in DOM
7. **Click di nuovo** → `aria-expanded="false"`; description NON più visibile (con animation potrebbe restare in DOM ma nascosta — testare via `aria-expanded` + visibilità classNames)
8. **Render expanded shop con parts_replaced_count=3 + has_attachments=true + attachments_count=2** → mostra "3 ricambi" e "Con allegati (2)"
9. **Render expanded shop con parts=0** → niente badge "ricambi"
10. **Render expanded private** → mostra description; mostra solo "Con allegati" se applicabile (private NON ha parts_replaced_count nel type)
11. **Render expanded shop con description vuota** → "Nessuna descrizione." in italic

### 5.2 `VehicleDetail.test.tsx` (NEW, jsdom + RTL, ~80 LOC)

Mock `useVehicleDetail` + `useVehicleTimeline` (TanStack Query mock pattern dal cycle PR #78).

1. **Loading state**: entrambi pending → 2 skeleton visible
2. **Vehicle 404**: detail.error 404 → toast `Veicolo non trovato`, navigate to `/`
3. **Vehicle error generico**: detail.error 500 → Alert "Riprova" button visible
4. **Happy path**: detail success + timeline 2 items (1 shop + 1 private) → header veicolo visibile, 2 TimelineRow renderate
5. **Archived vehicle**: status `archived` → button "Registra intervento" disabled
6. **Empty timeline**: timeline.data = `[]` → "Nessun intervento registrato per questo veicolo." visible

## 6. Non-goals (esplicito YAGNI)

- **Click-through al detail page intervento**: detail page non esiste. Followup ticket.
- **Edit intervento dalla timeline** (PATCH /interventions/:id): backend esiste, UI follow-up.
- **View dispute thread completo + responses**: solo presence badge v1, niente click-through.
- **Filtri** (per anno/categoria/has-disputes): slice D separato.
- **Search testuale**: YAGNI v1.
- **Attachments thumbnails**: solo flag "Con allegati", thumbnails sono detail page work.
- **Status badge intervention** (cancelled/active): non in scope, item.status non visualizzato.
- **i18n**: stringhe IT hardcoded.
- **Coordinazione globale accordion** (single-open): YAGNI, multi-open è scelta UX.
- **Tab state in URL** (preservare expanded state cross-refresh): YAGNI.

## 7. BR coverage

Niente BR direttamente — è UI puro che consuma endpoint esistente. La surface BR-129 (intervention dispute) ottiene visibilità per la prima volta lato officina (badge), che è il valore principale di questo slice.

## 8. Operational

- **Migration**: zero.
- **Env vars / CDK**: zero.
- **Backend changes**: zero.
- **Deploy**: standard CI → CloudFront. Niente operator-driven step.
- **Smoke** (post-deploy, manuale opzionale):
  1. Login web Giuseppe
  2. Cerca veicolo con interventi (es. via tab Cliente "Mario" → veicolo → scheda)
  3. Apri scheda veicolo → timeline visibile
  4. Click su una riga → expand mostra description + badges
  5. Verifica disputa badge se intervento ha `is_disputed=true` (richiede dataset reale o setup pilot)

## 9. PR description checklist

- [ ] Conventional Commits title `feat(web): timeline interventi con expand/collapse + dispute badge`
- [ ] Riferimento a strategia vertical slicing post #78 + Persona A Giuseppe demo
- [ ] Test plan: 1 nuovo TimelineRow.test.tsx + 1 nuovo VehicleDetail.test.tsx
- [ ] LOC ~355 (entro budget slice)
- [ ] BR-129 dispute surface menzionata come valore principale
- [ ] Smoke checklist post-deploy

## 10. Out of scope (tracked elsewhere)

- **Intervention detail page** (`/vehicles/:id/interventions/:iid`): slice futuro. Richiederà decision: riusare timeline DTO via location state vs nuovo `GET /v1/interventions/:id`.
- **Edit intervento UI** (consume PATCH /interventions/:id): slice futuro.
- **Dispute response UI** (consume POST /dispute-response): slice futuro.
- **Deadline list dashboard**: slice futuro (opzione B della pivot post-#78).
- **Customer detail + edit**: slice futuro (opzione C della pivot post-#78).
- **Mobile B2C scaffold**: differito a quando una feature B2C-critical lo richiede (vedi pivot strategia).
- **Followup tickets PR #78**: a11y tabpanel / customer name header / tab URL state / Customer.status type / CommandList polish / arrow keys.
