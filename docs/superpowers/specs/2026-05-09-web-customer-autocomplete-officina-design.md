# Design — Web wiring customer autocomplete officina

**Date:** 2026-05-09
**Type:** Frontend (web app officina), backend already shipped
**LOC budget:** ~630 net (135 shadcn Command scaffold + ~250 prod + ~200 test + ~45 modifiche minori)
**Drives:** Persona Giuseppe demo (F-WEB-DEMO3) — chiude end-to-end l'autocomplete officina iniziato con backend PR #76 + #77.
**Backend prerequisiti**: PR #76 (`GET /v1/vehicles/search?customer=<uuid>`) + PR #77 (`GET /v1/customers/search?q=`)

## 1. Why

L'autocomplete officina è il pattern di lookup che permette all'operatore di trovare un veicolo partendo da chi è al banco. I backend prerequisiti sono live in production. Senza wiring frontend, le API restano "plumbing-without-consumer". Questo PR consuma entrambe e chiude il loop demo: operatore digita "Mar" → vede customer Mario Rossi → seleziona → vede i suoi veicoli → clicca → registra intervento.

L'alternative path (digita VIN/targa/codice GO) resta intatto e default.

## 2. Architecture

### 2.1 UX flow

**Dashboard** acquisisce 2 tab: `Veicolo` (esistente) e `Cliente` (nuovo).

- Tab `Veicolo`: invariato — input free-text auto-detect VIN/plate/garage_code → `/search?q=<v>&t=<type>`.
- Tab `Cliente`: input con autocomplete dropdown live → operator seleziona customer dal dropdown → `navigate(/search?customer=<uuid>&t=customer)`.

**SearchResults** estende il branching su `t`:

- `t='vin'|'plate'|'garage_code'`: invariato (chiama `/v1/vehicles/search?q=...`).
- `t='customer'`: legge `customer=<uuid>` dal URL, chiama `/v1/vehicles/search?customer=<uuid>` (endpoint #76), mostra le stesse `VehicleResultCard`.

**InterventionCreate**: 0 modifiche. Il form già accetta vehicle pre-selezionato; il flow downstream (`VehicleDetail` → "Registra intervento" CTA → form) è invariato.

### 2.2 Data flow

```
Dashboard tab=Cliente
  └─ <CustomerAutocomplete onSelect={(c) => navigate(`/search?customer=${c.id}&t=customer`)}>
       └─ <Input> + Radix <Popover>
              └─ useDebouncedValue(input, 250)
              └─ useCustomerSearch(debouncedQ) → /v1/customers/search?q=<q>
              └─ <Command shouldFilter={false}>  // server filtra; cmdk client filter disabled
                   ├─ ↑↓ navigate items
                   ├─ ⏎ select highlighted
                   ├─ Esc close popover
                   └─ click item → onSelect(customer)

SearchResults
  └─ params t=customer → useVehicleSearch({ customerId: params.customer })
  └─ → /v1/vehicles/search?customer=<id>
  └─ Header: "Veicoli del cliente" + <id mono>
  └─ Lista VehicleResultCard invariata → click → /vehicles/<id>
```

### 2.3 Component dependencies

- shadcn `<Command>` (boilerplate da scaffoldare) — wraps `cmdk` package.
- shadcn `<Popover>` — già presente (`packages/web/src/components/ui/popover.tsx`).
- TanStack Query — già usato per `useVehicleSearch`, `useInterventionTypes`, ecc.
- Radix Tabs — NON usato. Tab toggle implementato custom (2 button con state, ~20 LOC) per evitare nuova dependency.

## 3. Files

### 3.1 NEW

| File | Purpose | LOC |
|---|---|---|
| `packages/web/src/components/ui/command.tsx` | shadcn Command boilerplate (Command/Input/List/Item/Empty/Loading/Group) | ~135 |
| `packages/web/src/queries/customerSearch.ts` | `useCustomerSearch(q)` con `enabled: q.length >= 2` | ~30 |
| `packages/web/src/components/CustomerAutocomplete.tsx` | Input + Popover + Command + debounce + onSelect callback | ~140 |
| `packages/web/src/lib/use-debounced-value.ts` | Hook generico `useDebouncedValue<T>(v: T, ms: number): T` | ~15 |
| `packages/web/src/components/CustomerAutocomplete.test.tsx` | Component-level tests (jsdom + vitest) | ~110 |

### 3.2 MODIFIED

| File | Change | LOC |
|---|---|---|
| `packages/web/package.json` | `+ "cmdk": "^1.0.0"` | +1 |
| `packages/web/src/queries/types.ts` | Aggiunge `Customer` DTO + `CustomerSearchResponse` | +20 |
| `packages/web/src/queries/vehicleSearch.ts` | Estende args con `customerId?: string` (mutuamente esclusivo con q+t) | +12 |
| `packages/web/src/lib/search-input.ts` | Estende `SearchType` union con `'customer'` | +1 |
| `packages/web/src/pages/Dashboard.tsx` | 2 button-tab toggle + render CustomerAutocomplete in tab Cliente | +50 |
| `packages/web/src/pages/SearchResults.tsx` | Branch `t='customer'` legge `customer=<uuid>`, chiama useVehicleSearch({ customerId }), header dedicato | +30 |
| `packages/web/src/pages/Dashboard.test.tsx` | Test tab switch + autocomplete onSelect → navigate | +50 |
| `packages/web/src/pages/SearchResults.test.tsx` | Test `t='customer'` flow | +40 |

### 3.3 Module shapes

**`useDebouncedValue.ts`**

```ts
import { useEffect, useState } from 'react';

export function useDebouncedValue<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}
```

**`customerSearch.ts`**

```ts
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { CustomerSearchResponse } from './types';

export function useCustomerSearch(q: string) {
  return useQuery({
    queryKey: ['customers', 'search', q],
    queryFn: () => {
      const search = new URLSearchParams({ q, limit: '20' });
      return apiFetch<CustomerSearchResponse>(`/v1/customers/search?${search.toString()}`);
    },
    enabled: q.trim().length >= 2,
    staleTime: 30_000,
  });
}
```

**`types.ts` additions**

```ts
export interface Customer {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  isBusiness: boolean;
  businessName: string | null;
  vatNumber: string | null;
  status: 'active';
}

export interface CustomerSearchResponse {
  data: Customer[];
  meta: { has_more: boolean; cursor?: string };
}
```

**`CustomerAutocomplete.tsx` skeleton**

```tsx
import { useState } from 'react';
import { Search } from 'lucide-react';
import {
  Command, CommandInput, CommandList, CommandItem,
  CommandEmpty, CommandLoading, CommandGroup,
} from '@/components/ui/command';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { useCustomerSearch } from '@/queries/customerSearch';
import type { Customer } from '@/queries/types';

interface Props {
  onSelect: (c: Customer) => void;
}

export function CustomerAutocomplete({ onSelect }: Props) {
  const [value, setValue] = useState('');
  const debounced = useDebouncedValue(value, 250);
  const open = value.trim().length >= 2;
  const query = useCustomerSearch(debounced);

  // Render Popover anchored on Input. Inside: Command list with
  // shouldFilter={false} (server filters), CommandLoading, CommandEmpty,
  // CommandItem rows. Each row: name + email + B2B badge.
  // ↑↓⏎ keyboard nav handled by cmdk internally; Esc handled by Popover.
  return (/* ... see plan for full skeleton ... */);
}
```

**`Dashboard.tsx` tab toggle**

```tsx
const [tab, setTab] = useState<'vehicle' | 'customer'>('vehicle');

return (
  <div ...>
    <h1>Cerca</h1>
    <div className="flex gap-2 mb-6">
      <Button variant={tab === 'vehicle' ? 'default' : 'outline'} onClick={() => setTab('vehicle')}>
        Veicolo
      </Button>
      <Button variant={tab === 'customer' ? 'default' : 'outline'} onClick={() => setTab('customer')}>
        Cliente
      </Button>
    </div>
    {tab === 'vehicle' ? <VehicleSearchForm /> : <CustomerAutocomplete onSelect={(c) => navigate(`/search?customer=${c.id}&t=customer`)} />}
  </div>
);
```

(L'esistente form veicolo va estratto in un sottocomponente locale `VehicleSearchForm` per chiarezza, oppure lasciato inline come ramo del JSX. Implementer sceglie in base alla leggibilità — ammessa flessibilità.)

**`SearchResults.tsx` branching**

```ts
const tRaw = params.get('t');
const t = isValidType(tRaw) ? tRaw : null;
const customerId = params.get('customer');

// Customer-by-id branch
if (t === 'customer') {
  if (!customerId || !UUID_RE.test(customerId)) {
    return <Alert variant="destructive">Parametri di ricerca invalidi.</Alert>;
  }
  const query = useVehicleSearch({ customerId });
  // ... render results ...
}
// q-by-type branch (existing)
```

**`vehicleSearch.ts` extension**

```ts
type SearchArgs =
  | { q: string; t: SearchType; customerId?: never }
  | { customerId: string; q?: never; t?: never };

export function useVehicleSearch(args: SearchArgs) {
  return useInfiniteQuery({
    queryKey: ['vehicles', 'search', args],
    queryFn: ({ pageParam }) => {
      const search = new URLSearchParams();
      if ('customerId' in args && args.customerId) {
        search.set('customer', args.customerId);
      } else if (args.q && args.t) {
        search.set(args.t, args.q);
      }
      search.set('limit', '20');
      if (pageParam) search.set('cursor', pageParam);
      return apiFetch<VehicleSearchResponse>(`/v1/vehicles/search?${search.toString()}`);
    },
    enabled: 'customerId' in args ? !!args.customerId : !!args.q && !!args.t,
    // ...
  });
}
```

## 4. Edge cases & error handling

| Caso | Handling |
|---|---|
| q < 2 char | Hint "Digita almeno 2 caratteri" nel popover; useCustomerSearch è `enabled: false`, niente fetch |
| q valido + 0 risultati | `<CommandEmpty>Nessun cliente trovato.</CommandEmpty>` |
| Network 4xx/5xx | `<CommandEmpty>Errore. Riprova.</CommandEmpty>` (or simile) — niente toast invasivo per autocomplete |
| Loading | `<CommandLoading>Cercando…</CommandLoading>` (cmdk built-in) |
| Click fuori | Popover closes (Radix default) |
| Esc tasto | Popover closes (cmdk + Radix) |
| Refresh Dashboard | Ritorna a tab Veicolo (default state) — accettato, non in URL |
| Refresh SearchResults `?customer=<id>&t=customer` | URL persiste, query rifatta — OK |
| `?customer=` non-UUID su SearchResults | "Parametri di ricerca invalidi." (riusa Alert esistente) |
| Customer pool token (clienti) | Backend ritorna 403 → query state error → CommandEmpty errore. Edge case improbabile (clienti pool non passa da officina dashboard) ma gestito |

## 5. Test plan

### 5.1 `CustomerAutocomplete.test.tsx` (jsdom + vitest)

1. **Render iniziale**: input vuoto, popover chiuso (assert `aria-expanded` su input se presente, o assenza `<CommandList>` nel DOM).
2. **q < 2 char no fetch**: type "a", advance fake timers 300ms, mock `apiFetch` non chiamato.
3. **q ≥ 2 char debounce 250ms**: type "ma", advance 100ms (no fetch), advance 250ms (fetch fired con `q=ma`).
4. **Loading state**: useQuery in pending → CommandLoading "Cercando…" visible.
5. **Empty state**: query returns `data: []` → "Nessun cliente trovato." visible.
6. **Error state**: query rejects → fallback empty state with error copy.
7. **3-row dropdown**: query returns 1 B2C + 1 B2B + 1 B2C → 3 CommandItem render con nome+email; B2B row ha `<Badge>B2B</Badge>`.
8. **Click select**: click sul 2° item → onSelect callback invocata con full Customer object.
9. **Keyboard ↓↓⏎**: simula 2× ArrowDown + Enter → onSelect del 2° item.

(Pattern memoria `feedback_jsdom_radix_select_mock_pattern` non si applica qui perché Command/Popover di cmdk non usa portal con altezza zero per CommandItem rendering — diversamente da Radix Select. Ma se in fase implementer scopre che il portal blocca l'asserzione, fallback è module-mock CustomerAutocomplete dal Dashboard test e test diretto via callback simulato.)

### 5.2 `Dashboard.test.tsx` (estensione)

- Default tab = `Veicolo`: input VIN/plate/code visibile, autocomplete NON visibile.
- Click button "Cliente" → autocomplete visibile, vehicle search input nascosto.
- Tab switch back: input vehicle visibile.
- Mock `CustomerAutocomplete` come stub che esercita `onSelect` con un Customer fixture → assert `useNavigate` chiamato con `/search?customer=<id>&t=customer`.

### 5.3 `SearchResults.test.tsx` (estensione)

- `?customer=<valid-uuid>&t=customer` → mock `useVehicleSearch({ customerId })` ritorna 2 veicoli → 2 VehicleResultCard renderate.
- Header mostra "Veicoli del cliente" + UUID mono.
- `?customer=invalid&t=customer` → Alert "Parametri di ricerca invalidi.".
- `?customer=&t=customer` (assente) → stesso Alert.

## 6. Non-goals (esplicito YAGNI)

- **Nome customer mostrato in header SearchResults**: dopo navigate, abbiamo solo l'UUID. Niente fetch dedicato per il nome (richiederebbe `GET /v1/customers/:id`). Header v1 mostra solo "Veicoli del cliente" + UUID mono. **Followup PR**: o passare il nome via location state (perso al refresh) o creare endpoint dettaglio.
- **Cronologia ultimi customer** (recent searches): YAGNI v1.
- **Mobile-friendly Combobox UX**: scope desktop officina.
- **i18n**: stringhe IT hardcoded come tutto il web v1.
- **Tab state in URL** (`?tab=customer`): YAGNI — refresh ritorna a default Veicolo.
- **CustomerVehicles dedicated page**: SearchResults riusato.
- **Avatar / iniziali colorate** in dropdown: solo testo.
- **InterventionCreate modifications**: zero.
- **Customer detail page** `/customers/:id`: separato.

## 7. BR coverage

Nessun BR direttamente — è UI puro che consuma endpoint esistenti che già implementano BR-151 etc.

## 8. Operational

- **Migration**: zero.
- **Env vars**: zero.
- **CDK**: zero.
- **Deploy**: standard CI → CloudFront. Niente operator-driven step.
- **Smoke** (post-deploy, manuale opzionale):
  1. Login web app come Giuseppe operator.
  2. Click tab Cliente.
  3. Type "Mario" → assert dropdown popola con i Mario related al tenant.
  4. Click un risultato → URL diventa `/search?customer=<id>&t=customer`.
  5. SearchResults mostra i veicoli del customer.
  6. Click un VehicleResultCard → VehicleDetail → "Registra intervento" → form open.

## 9. PR description checklist

- [ ] Conventional Commits title `feat(web): customer autocomplete officina (Persona Giuseppe demo)`
- [ ] Riferimento a F-WEB-DEMO3 / Persona A use case
- [ ] Cita PR #76 + #77 come backend prerequisiti
- [ ] Test plan: 1 nuovo test file + 2 estesi
- [ ] LOC ~630 (sopra soft target 500, motivato shadcn Command scaffold; entro hard limit 1500)
- [ ] Smoke checklist post-deploy
- [ ] Followup ticket: "header nome customer in SearchResults" (richiede `/v1/customers/:id` o location state)

## 10. Out of scope (tracked elsewhere)

- **Mobile B2C scaffold (Opzione B)**: greenfield Expo, post questo PR.
- **H2 push channel**: dopo mobile B2C.
- **F Sentry SDK**: standalone.
- **Followup tickets opus PR #77**: DRY cursor refactor compound-cursor routes / wildcard-injection test / F-OFF code review.
