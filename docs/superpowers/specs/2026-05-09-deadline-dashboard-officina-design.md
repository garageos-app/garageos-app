# Design — Dashboard scadenze officina (F-OFF-402)

**Date:** 2026-05-09
**Type:** Web + small backend (vertical slice)
**LOC budget:** ~970 net (~440 backend + 510 web + 30 doc)
**Drives:** F-OFF-402 — "Vista scadenze in arrivo: Dashboard delle scadenze raggruppate per 'questa settimana / questo mese / prossimi 3 mesi'. Filtri per location, tipo scadenza" — MUST priority. Secondo vertical slice post pivot agile.
**Backend prerequisiti shipped:** schema deadlines + RLS `deadlines_tenant_isolation` + create/update/delete/complete + per-vehicle list. Manca SOLO l'endpoint aggregato officina-side.

## 1. Why

L'officina deve avere un controllo daily sulle scadenze in arrivo per:
- Pianificare workload settimana/mese
- Richiamare commercialmente clienti con scadenze (F-OFF-404)
- Anticipare carico per gomme stagionali / revisioni / tagliandi

Oggi il backend ha tutta la macchineria (cluster H1+H3 reminders email + per-vehicle list + create/complete/delete) ma il web officina non mostra niente: l'operatore vede le scadenze SOLO aprendo la scheda veicolo singolo (e neanche tutte — solo via timeline indiretta).

Questo slice introduce l'aggregato `GET /v1/deadlines` officina-side + la dashboard `/deadlines` con groupings F-OFF-402 + filtro tipo + click-through al veicolo. Aderente al pivot vertical slicing demo-driven.

## 2. Architecture

### 2.1 Backend nuovo endpoint

`GET /v1/deadlines?status=&intervention_type_id=&limit=&cursor=`

**Auth:** officina pool only (`requireAuth + requireOfficinaPool + tenantContext`).

**Query schema (Zod):**
- `status?: 'open' | 'completed' | 'overdue' | 'cancelled'` (default `'open'`)
- `intervention_type_id?: string()` (UUID, optional)
- `limit?: coerce.number().int().min(1).max(100).default(50)`
- `cursor?: string()` (UUID, optional)

**Tenant scoping:** RLS `deadlines_tenant_isolation` (`is_admin_role() OR tenant_id = current_tenant_id()`). Tutte le rows ritornate sono per costruzione del tenant chiamante.

**Order:** `dueDate ASC NULLS LAST`, then `id ASC` (tie-break stabile per cursor).

**Cursor pagination:** mirror di `deadlines-list-vehicle.ts`:
- `take: limit + 1`, peek `hasMore`
- Slice + return `nextCursor = items[items.length - 1]!.id` if hasMore else null
- Next page via `cursor: { id: cursorId }, skip: 1`

**DTO**: include nested `vehicle` (id, plate, make, model, currentOwnership con customer PII-filtered) + `interventionType` (id, code, nameIt).

**BR-151 PII filter** application-layer (mirror del pattern `vehicles/search` PR #76):
- Estrai customerIds dalle ownerships attive di tutti i vehicles ritornati
- `resolvePiiVisibility({ tx, tenantId, customerIds })` → Set<string> visibili
- Per ogni row: `maskCustomer(customer, visibleSet.has(customerId))` → mostra fields o redacted shape

**Note: status `overdue`**: l'enum esiste ma nessun cron lo aggiorna oggi nel codice. Il filter lo accetta per compatibilità futura, ma il frontend deriva `effectiveStatus` da `dueDate < today && status === 'open'`. Followup ticket per cron auto-overdue.

### 2.2 Web pages

**Sidebar nav `Scadenze`** abilitato (era `enabled: false` con badge "soon"). Click → `/deadlines`.

**New route `/deadlines` → `<DeadlineDashboard />`**:
- Header "Scadenze in arrivo"
- Filter row: dropdown `<Select>` "Tutti i tipi / TAGLIANDO / GOMME / REVISIONE / ...". Consume `useInterventionTypes` (esistente da PR intervention-types-list).
- Body: 4 sezioni groupings (Scadute / Questa settimana / Questo mese / Prossimi 3 mesi).
- Loading: skeletons.
- Error: Alert + Riprova.
- Empty (zero rows totali): "Nessuna scadenza configurata." con SearchX icon.
- Empty per filter: "Nessuna scadenza per il tipo selezionato."
- Bottom: "Carica altre" button if `hasNextPage`.

**`<DeadlineRow />` component**:
- Click target: `<button>` su tutta la row → `navigate('/vehicles/:id')`.
- Layout: `[veicolo make model + plate mono] · [type nameIt] · [dueDate formatted | "X.XXX km"] · [customer name | "—" if redacted]`.
- Badge sezione (impliciti via grouping; niente badge a livello row).

### 2.3 Grouping logic (frontend)

`packages/web/src/lib/deadline-grouping.ts`:

```ts
export function isOverdue(d: TenantDeadline, today: Date): boolean {
  if (d.status !== 'open' || !d.dueDate) return false;
  return new Date(d.dueDate) < today;
}

export type DeadlineBuckets = {
  overdue: TenantDeadline[];
  thisWeek: TenantDeadline[];
  thisMonth: TenantDeadline[];
  threeMonths: TenantDeadline[];
};

export function groupByDueBucket(items: TenantDeadline[], today: Date): DeadlineBuckets;
```

**Bucket boundaries** (relativi a `today` a mezzanotte locale):
- `overdue`: `isOverdue(d, today)`
- `thisWeek`: `today ≤ dueDate ≤ today + 7d` (7 giorni inclusi)
- `thisMonth`: `today + 8d ≤ dueDate ≤ today + 30d`
- `threeMonths`: `today + 31d ≤ dueDate ≤ today + 90d`
- (Beyond 90d → escluse v1)
- (`dueDate === null` → escluse v1, "solo km" non bucketabile)

## 3. Files

### 3.1 NEW

| File | Purpose | LOC |
|---|---|---|
| `packages/api/src/routes/v1/deadlines-list-tenant.ts` | Route handler | ~110 |
| `packages/api/tests/integration/deadlines-list-tenant.test.ts` | 7-8 scenari real-DB | ~200 |
| `packages/web/src/queries/deadlinesList.ts` | `useDeadlinesList(filters)` | ~30 |
| `packages/web/src/lib/deadline-grouping.ts` | `groupByDueBucket` + `isOverdue` | ~50 |
| `packages/web/src/lib/deadline-grouping.test.tsx` | Helper unit tests | ~80 |
| `packages/web/src/components/DeadlineRow.tsx` | Row presentational | ~60 |
| `packages/web/src/components/DeadlineRow.test.tsx` | Component tests | ~80 |
| `packages/web/src/pages/DeadlineDashboard.tsx` | Page | ~180 |
| `packages/web/src/pages/DeadlineDashboard.test.tsx` | Page integration | ~120 |

### 3.2 MODIFIED

| File | Change | LOC |
|---|---|---|
| `packages/api/src/server.ts` | Register `deadlinesListTenantRoutes` | +2 |
| `packages/web/src/queries/types.ts` | Add `DeadlineStatus`, `TenantDeadline`, `DeadlinesListResponse` | +25 |
| `packages/web/src/components/layout/Sidebar.tsx` | Enable Scadenze nav (remove `enabled: false`, add `to: '/deadlines'`) | ~5 |
| `packages/web/src/App.tsx` (or wherever routes live) | Add `<Route path="/deadlines" element={<DeadlineDashboard />}>` | +2 |
| `docs/APPENDICE_A_API.md` | Document new endpoint section §2.x or §3.x | +30 |

### 3.3 Module shapes

**Backend route skeleton** (`deadlines-list-tenant.ts`):

```ts
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { resolvePiiVisibility } from '../../lib/pii-filter.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

// GET /v1/deadlines — F-OFF-402.
//
// Officina-side aggregate read of all deadlines for the calling
// tenant. RLS deadlines_tenant_isolation guarantees tenant scoping.
// Customer PII gated by BR-151 via resolvePiiVisibility +
// maskCustomer (mirror del pattern vehicles/search PR #76).
//
// Note: 'overdue' status is in the enum but no cron updates it today.
// The filter accepts it for forward-compat; frontend derives
// effectiveStatus from (dueDate < today && status === 'open').

const querySchema = z.object({
  status: z.enum(['open', 'completed', 'overdue', 'cancelled']).default('open'),
  intervention_type_id: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.uuid().optional(),
});

const deadlinesListTenantRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/deadlines',
    { preHandler: [requireAuth, requireOfficinaPool, tenantContext] },
    async (request, reply) => {
      const { status, intervention_type_id, limit, cursor } = querySchema.parse(request.query);
      const tenantId = request.tenantId!;

      return app.withContext({ tenantId }, async (tx) => {
        const rows = await tx.deadline.findMany({
          where: {
            status,
            ...(intervention_type_id ? { interventionTypeId: intervention_type_id } : {}),
          },
          orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
          take: limit + 1,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          select: {
            id: true,
            vehicleId: true,
            interventionTypeId: true,
            dueDate: true,
            dueOdometerKm: true,
            description: true,
            isRecurring: true,
            status: true,
            interventionType: { select: { id: true, code: true, nameIt: true } },
            vehicle: {
              select: {
                id: true,
                plate: true,
                make: true,
                model: true,
                ownerships: {
                  where: { endedAt: null },
                  take: 1,
                  select: {
                    customer: {
                      select: {
                        id: true,
                        firstName: true,
                        lastName: true,
                        email: true,
                        phone: true,
                        isBusiness: true,
                        businessName: true,
                        vatNumber: true,
                      },
                    },
                  },
                },
              },
            },
          },
        });

        const hasMore = rows.length > limit;
        const items = hasMore ? rows.slice(0, limit) : rows;

        // BR-151 PII visibility per row's customer (if any active ownership).
        const customerIds = items
          .flatMap((d) => d.vehicle.ownerships.map((o) => o.customer?.id))
          .filter((id): id is string => Boolean(id));
        const visibleSet = await resolvePiiVisibility({ tx, tenantId, customerIds });

        const data = items.map((d) => {
          const ownership = d.vehicle.ownerships[0] ?? null;
          const cust = ownership?.customer ?? null;
          return {
            id: d.id,
            vehicleId: d.vehicleId,
            interventionTypeId: d.interventionTypeId,
            dueDate: d.dueDate,
            dueOdometerKm: d.dueOdometerKm,
            description: d.description,
            isRecurring: d.isRecurring,
            status: d.status,
            interventionType: d.interventionType,
            vehicle: {
              id: d.vehicle.id,
              plate: d.vehicle.plate,
              make: d.vehicle.make,
              model: d.vehicle.model,
              currentOwnership: cust
                ? { customer: maskCustomer(cust, visibleSet.has(cust.id)) }
                : null,
            },
          };
        });

        const nextCursor = hasMore ? items[items.length - 1]!.id : null;
        return reply.send({ deadlines: data, nextCursor });
      });
    },
  );
};

export default deadlinesListTenantRoutes;
```

(Note: `maskCustomer` import omitted in skeleton — the implementer should add `import { maskCustomer, resolvePiiVisibility } from '../../lib/pii-filter.js';`.)

**Web types additions**:

```ts
// packages/web/src/queries/types.ts (additions)
export type DeadlineStatus = 'open' | 'completed' | 'overdue' | 'cancelled';

export interface TenantDeadlineVehicleOwnership {
  customer: MaskedCustomer | (CustomerRow & { redacted: false }) | { id: string; redacted: true; displayName: string } | null;
}

export interface TenantDeadlineVehicle {
  id: string;
  plate: string;
  make: string;
  model: string;
  currentOwnership: TenantDeadlineVehicleOwnership | null;
}

export interface TenantDeadline {
  id: string;
  vehicleId: string;
  interventionTypeId: string;
  dueDate: string | null;
  dueOdometerKm: number | null;
  description: string | null;
  isRecurring: boolean;
  status: DeadlineStatus;
  vehicle: TenantDeadlineVehicle;
  interventionType: { id: string; code: string; nameIt: string };
}

export interface DeadlinesListResponse {
  deadlines: TenantDeadline[];
  nextCursor: string | null;
}
```

(The MaskedCustomer/CustomerRow types are already in `types.ts`; the implementer should reuse the existing PII discriminated union shape from `vehicles/search` query DTO instead of declaring a new variant.)

**Web query hook** (`deadlinesList.ts`):

```ts
import { useInfiniteQuery } from '@tanstack/react-query';

import { useApiFetch } from '@/lib/api-client';

import type { DeadlinesListResponse } from './types';

interface DeadlinesFilters {
  interventionTypeId?: string;
}

export function useDeadlinesList(filters: DeadlinesFilters) {
  const apiFetch = useApiFetch();
  return useInfiniteQuery({
    queryKey: ['deadlines-list-tenant', filters] as const,
    queryFn: ({ pageParam }) => {
      const search = new URLSearchParams();
      search.set('status', 'open');
      if (filters.interventionTypeId) {
        search.set('intervention_type_id', filters.interventionTypeId);
      }
      search.set('limit', '50');
      if (pageParam) search.set('cursor', pageParam);
      return apiFetch<DeadlinesListResponse>(`/v1/deadlines?${search.toString()}`);
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 60_000,
  });
}
```

**Web Sidebar.tsx mod**:

```ts
const navItems = [
  { id: 'search', label: 'Cerca veicolo', icon: Search, to: '/', enabled: true },
  { id: 'interventions', label: 'Interventi', icon: Wrench, enabled: false },
  { id: 'deadlines', label: 'Scadenze', icon: Calendar, to: '/deadlines', enabled: true },
  { id: 'customers', label: 'Clienti', icon: Users, enabled: false },
  { id: 'settings', label: 'Impostazioni', icon: Settings, enabled: false },
] as const;
```

(Note: import `Calendar` from `lucide-react`; update `isSearchActive` per accommodate the new path so sidebar highlight non si confonde — implementer aggiunge una nuova `isDeadlinesActive` o estende `isActive` switch.)

## 4. Edge cases

| Caso | Handling |
|---|---|
| `status='overdue'` filter (enum exists) | Backend accetta, ritorna zero rows oggi (no cron). Frontend NON usa questo path |
| `dueDate === null` deadline (solo km) | Esclusa da tutti i bucket frontend; row visibile solo se filter status overrides |
| Bucket vuoto | Sezione mostra header con "(0)" + "Nessuna scadenza" inline |
| Customer redacted (BR-151) | Nome mostrato come "—" |
| Customer null (vehicle senza owner attivo) | Nome "—" |
| Beyond 90d | Esclusa v1 (followup) |
| Filter applicato + zero match | Empty state "Nessuna scadenza per il tipo selezionato." |
| Tenant senza scadenze | Empty state pagina-wide |
| Cursor pagination | Frontend ri-bucketizza ad ogni page (semplice flat → group) |
| `intervention_type_id` filter UUID invalid | Zod 400 |
| Auth 401 / 403 | Standard error path |

## 5. Test plan

### 5.1 Backend integration (`deadlines-list-tenant.test.ts`)

Pattern mirror `vehicles-search.test.ts` (real Postgres + RLS):

1. **Tenant scoping**: tenant A 2 deadlines, tenant B 1 deadline → calling A returns A's 2 only
2. **Default `status='open'` filter**: dataset con 1 open + 1 completed + 1 cancelled → ritorna solo open
3. **`?status=cancelled`**: override → ritorna solo cancelled rows
4. **`?intervention_type_id=<uuid>`**: 3 deadlines diversi tipi, filter → ritorna solo matching
5. **PII visible**: tenant related to customer → response include `customer.firstName`
6. **PII redacted**: tenant NOT related → `customer.redacted=true`, no firstName
7. **Cursor pagination**: 3 deadlines + limit=2 → page1 (2 rows + nextCursor), page2 (1 row + nextCursor=null), union covers all
8. **401 senza token, 403 con clienti pool token**

### 5.2 Web — `deadline-grouping.test.tsx`

1. Empty input → all buckets `[]`
2. Mix of overdue/week/month/3months → correct bucketing
3. `status='completed'` con dueDate past → NOT in overdue
4. `dueDate=null` → excluded all buckets
5. Boundary cases: today exactly / today+7d / today+30d / today+90d → correct bucket assignment

### 5.3 Web — `DeadlineRow.test.tsx`

1. Render con `dueDate` → mostra data formattata
2. Render con `dueOdometerKm` only (no `dueDate`) → mostra "X.XXX km"
3. Render con customer visibile → mostra `firstName lastName`
4. Render con customer redacted → mostra "—"
5. Click row → `navigate(/vehicles/:id)` chiamato

### 5.4 Web — `DeadlineDashboard.test.tsx`

1. Loading skeletons
2. Error alert + Riprova button on API failure
3. Happy path: dataset con 4 buckets → 4 sezioni rendered con count corretti
4. Empty state pagina-wide (zero deadlines totali)
5. Filter dropdown change → query refetch con nuovo `intervention_type_id`
6. "Carica altre" button quando `hasNextPage`

## 6. Non-goals (esplicito YAGNI)

- **Quick-complete modal**: click row apre VehicleDetail, F-OFF-405 completion via intervention link è slice futuro
- **Filtro per location**: F-OFF-402 lo prevede, ma pivot v1 minimal. Followup
- **Filtro range custom date**: solo i 4 bucket fissi
- **Cron auto-overdue status update**: enum esiste ma nessun job; frontend deriva. Followup ticket per backend cron
- **Recurring deadlines visualization**: campo `isRecurring` nel DTO, no UI v1
- **Bulk operations** (multiple complete/cancel)
- **Export CSV/PDF**
- **Sort options** (per veicolo, per cliente)
- **Mobile responsive**: scope desktop officina demo
- **Pagination "intelligente" cross-bucket**: ogni page rifà il bucketing flat
- **Deadline detail page**: click va al veicolo

## 7. BR coverage

| BR | Status | Note |
|---|---|---|
| BR-100 | N/A backend | Validation è già in deadlines-create.ts (almeno uno tra dueDate/dueOdometerKm); list endpoint non valida |
| BR-101 | N/A backend | Dual-criteria già implementato in cron H3 reminder logic |
| BR-150 | N/A | Vehicles read permissive ma deadlines tenant-isolated |
| **BR-151** | ✅ | PII filter customer via `resolvePiiVisibility` + `maskCustomer` (BR-151) |
| F-OFF-402 | ✅ | Implementato (groupings + filtro tipo). Filtro location postponed |
| F-OFF-404 | Parziale | Dashboard surface scadenze in arrivo abilita richiamo commerciale; segnalazione automatica "non contattati" è SHOULD futuro |

## 8. Operational

- **Migration**: zero (schema invariato)
- **Env vars / CDK**: zero
- **Backend**: nuovo route, register in server.ts
- **Deploy**: standard CI → App Runner (api) + CloudFront (web)
- **Smoke** (post-deploy):
  1. Login web Giuseppe
  2. Click Sidebar "Scadenze"
  3. Vedi dashboard con scadenze (richiede dataset deadline su prod o pilot env)
  4. Filtra per tipo → query rifatta
  5. Click su una row → naviga al veicolo

## 9. PR description checklist

- [ ] Conventional Commits title `feat(api,web): dashboard scadenze officina (F-OFF-402)`
- [ ] Riferimento a F-OFF-402 + secondo vertical slice post pivot agile
- [ ] Test plan: 1 backend integration + 3 web (helper + row + page)
- [ ] BR-151 PII coverage citata
- [ ] LOC ~970 (sopra soft target 500, motivato backend + page nuova + helper)
- [ ] Smoke checklist

## 10. Out of scope (tracked elsewhere)

- **Cron auto-overdue**: backend job che setta status='overdue' quando dueDate passa. Followup ticket separato
- **Filtro location** (multi-sede officine): followup ticket F-OFF-402 completion
- **Quick-complete modal** (F-OFF-405 closure): slice futuro
- **Recurring deadlines UI** (icon + label "ogni 12 mesi"): polish slice
- **Bulk actions / export**: YAGNI
- **Followup tickets PR #77/#78/#79** ancora aperti
