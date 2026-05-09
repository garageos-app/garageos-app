# Design — `GET /v1/customers/search` (E2 customer autocomplete)

**Date:** 2026-05-09
**Type:** API endpoint, backend-only
**LOC budget:** ~290 net (100 prod [route 80 + cursor 20] + 170 test [unit 40 + integration 130] + 30 doc + 2 register hook − 10 vehicles refactor)
**Drives:** autocomplete officina UI per `intervention create` (Persona Giuseppe, demo F-WEB-DEMO3)
**Complements:** PR #76 `GET /v1/vehicles/search?customer=<uuid>` — questa è la metà 1 (trova il customer per nome digitato), #76 è la metà 2 (filtra i veicoli del customer scelto)

## 1. Why

Use case Giuseppe (Persona A officina demo): nel form "Registra intervento", dopo aver scelto la categoria, deve digitare 2-3 lettere del nome cliente e ottenere una lista di customer già in anagrafica. Selezionato il customer, l'UI fa una seconda chiamata `/v1/vehicles/search?customer=<uuid>` (PR #76) per popolare il dropdown veicoli.

Senza questo endpoint, l'autocomplete non può funzionare: l'unica strada attuale è `customer.mode='create_new'` (che crea un nuovo customer ogni volta) o costringere l'operatore a memorizzare/cercare a mano l'`id` UUID del customer.

## 2. Contract

### 2.1 HTTP

```
GET /v1/customers/search?q=<query>&limit=<N>&cursor=<base64url>
```

**Auth:** `[requireAuth, requireOfficinaPool, tenantContext]` — solo officina pool (Cognito group `officina`).

### 2.2 Query schema (Zod)

```ts
const searchQuerySchema = z.object({
  q: z.string().min(2).max(60),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
});
```

- `q` minimo 2 char per evitare result set giganti su tenant grossi e per ridurre PII surface (single-letter è troppo permissivo).
- `q` massimo 60 char è arbitrario ma copre il caso più lungo realistico (es. "Distribuzione Carburanti S.p.A. di Verona Centro").
- `limit` default 20, max 50 — coerente con `vehicles/search`.

### 2.3 Tenant scoping

Solo customer in `customer_tenant_relations` per il tenant chiamante, con `customerDeleted=false`. Cross-tenant è esplicitamente escluso (vedi §6 Non-goals).

```ts
where: {
  status: 'active',
  tenantRelations: { some: { tenantId, customerDeleted: false } },
  OR: [
    { firstName:    { contains: q, mode: 'insensitive' } },
    { lastName:     { contains: q, mode: 'insensitive' } },
    { businessName: { contains: q, mode: 'insensitive' } },
  ],
}
```

- `tenantRelations.some` traduce in EXISTS subquery sul `customer_tenant_relations` (idx `idx_customer_tenant_customer` su `customer_id`; il filtro `tenantId` lo accelera tramite uq `uq_customer_tenant`).
- `status = 'active'` esclude `pending_verification` (signup non concluso) e `deleted` (soft delete).
- Prisma escapes `%`/`_` dentro `contains` → `q='Mar%io'` è safe.

### 2.4 Match strategy

ILIKE substring case-insensitive su `firstName`, `lastName`, `businessName`. **Email, taxCode, vatNumber NON sono campi matchabili** (PII surface scelta dall'utente).

Performance: per dataset officina realistico (decine–centinaia di customer per tenant), ILIKE su seq scan è O(n) ma trascurabile. pg_trgm + indice GIN è esplicitamente YAGNI.

### 2.5 Pagination

Cursor pagination identica a `vehicles/search`:

```ts
orderBy: { id: 'asc' },
take: limit + 1,
...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
```

Cursor è base64url di `{ id }` con helper estratto in `lib/cursor.ts` (vedi §3.2).

### 2.6 Response

```ts
type SearchResponse = {
  data: Array<{
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    phone: string | null;
    isBusiness: boolean;
    businessName: string | null;
    vatNumber: string | null;
    status: 'active';
  }>;
  meta: {
    has_more: boolean;
    cursor?: string;
  };
};
```

- **No PII redaction**: ogni riga ritornata è per costruzione tenant-related (la JOIN su `customer_tenant_relations` lo garantisce), quindi BR-151 è automaticamente soddisfatto. Niente `redacted: true` shape.
- **No `redacted` discriminator**: a differenza di `vehicles/search`, qui non serve.
- `status` sempre `'active'` (filtrato in WHERE) — incluso per coerenza DTO ma è un literal de facto.

### 2.7 Error responses

| Status | Caso | Body |
|---|---|---|
| 400 | Zod validation (q troppo corta/lunga, limit fuori range, q mancante) | `{ code, detail }` RFC 7807 esistente |
| 401 | JWT mancante/invalido | middleware `requireAuth` |
| 403 | Pool non-officina | middleware `requireOfficinaPool` |
| 200 | Match vuoto | `{ data: [], meta: { has_more: false } }` |

## 3. Files & components

### 3.1 New

| File | Purpose | LOC |
|---|---|---|
| `packages/api/src/routes/v1/customers.ts` | Route plugin con search handler | ~80 |
| `packages/api/src/lib/cursor.ts` | Estratto `encodeCursor`/`decodeCursor` (id-based) | ~20 |
| `packages/api/tests/unit/routes/v1/customers.test.ts` | Schema validation cases (Prisma stubbed) | ~40 |
| `packages/api/tests/integration/customers-search.test.ts` | Real-DB scenarios | ~130 |

### 3.2 Modified

| File | Change | LOC |
|---|---|---|
| `packages/api/src/server.ts` | `import customerRoutes from './routes/v1/customers.js'` + `await app.register(customerRoutes)` | +2 |
| `packages/api/src/routes/v1/vehicles.ts` | Sostituisce inline `encodeCursor`/`decodeCursor` con import da `lib/cursor.ts` | ~−10 |
| `docs/APPENDICE_A_API.md` | Aggiunge sezione `### GET /v1/customers/search` | +30 |

### 3.3 Module shape

```ts
// packages/api/src/lib/cursor.ts
export function encodeCursor(id: string): string {
  return Buffer.from(JSON.stringify({ id }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): string | undefined {
  if (!cursor) return undefined;
  try {
    const obj = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      id?: string;
    };
    return typeof obj.id === 'string' ? obj.id : undefined;
  } catch {
    return undefined;
  }
}
```

```ts
// packages/api/src/routes/v1/customers.ts (skeleton)
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { encodeCursor, decodeCursor } from '../../lib/cursor.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

const searchQuerySchema = z.object({
  q: z.string().min(2).max(60),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
});

const customerSearchSelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  isBusiness: true,
  businessName: true,
  vatNumber: true,
  status: true,
} as const;

const customerRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/customers/search',
    { preHandler: [requireAuth, requireOfficinaPool, tenantContext] },
    async (request) => {
      const { q, limit, cursor } = searchQuerySchema.parse(request.query);
      const tenantId = request.tenantId!;

      return app.withContext({ tenantId }, async (tx) => {
        const cursorId = decodeCursor(cursor);
        const rows = await tx.customer.findMany({
          where: {
            status: 'active',
            tenantRelations: { some: { tenantId, customerDeleted: false } },
            OR: [
              { firstName:    { contains: q, mode: 'insensitive' } },
              { lastName:     { contains: q, mode: 'insensitive' } },
              { businessName: { contains: q, mode: 'insensitive' } },
            ],
          },
          select: customerSearchSelect,
          orderBy: { id: 'asc' },
          take: limit + 1,
          ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
        });

        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        const lastRow = page.at(-1);

        return {
          data: page,
          meta: {
            has_more: hasMore,
            ...(hasMore && lastRow ? { cursor: encodeCursor(lastRow.id) } : {}),
          },
        };
      });
    },
  );
};

export default customerRoutes;
```

## 4. Test plan

### 4.1 Unit (`tests/unit/routes/v1/customers.test.ts`)

Vitest + Prisma stub (mirror di `vehicles.test.ts` PR #76):

1. `q` mancante → 400.
2. `q` length < 2 → 400.
3. `q` length > 60 → 400.
4. `limit < 1` → 400.
5. `limit > 50` → 400.
6. Valid query → 200 con shape DTO atteso (Prisma stub returns `[]`).

### 4.2 Integration (`tests/integration/customers-search.test.ts`)

Testcontainers Postgres, real RLS, dedicated `remoteAddress: '10.20.30.<N>'` per evitare rate-limit cross-test (vedi `feedback_integration_test_rate_limit_isolation.md`):

1. **Tenant scoping**: tenant A ha (Mario Rossi, Mario Bianchi) related; tenant B ha (Mario Verdi) related. Calling come A con `q=Mario` → ritorna `[Rossi, Bianchi]`, NOT Verdi.
2. **BR-151 cross-tenant non-leakage**: tenant A è related a Customer X (firstName='Mario'); tenant B non è related a X. Calling come B con `q=Mario` → `[]`. Esplicito test che la JOIN non leaka.
3. **ILIKE substring + case-insensitive**: dataset con (Mario, MARCO, Marina) → `q=mar` ritorna 3 righe; `q=ROS` ritorna chi ha lastName 'Rossi'.
4. **Match su businessName (B2B)**: customer con `isBusiness=true, businessName='Trattoria Da Luigi'` → `q=trattoria` ritorna la riga.
5. **`customerDeleted=true` esclusione**: customer M related ma con flag CTR `customerDeleted=true` → `q=<nome>` non lo ritorna.
6. **`status != 'active'` esclusione**: customer pending_verification + customer deleted entrambi related → non appaiono.
7. **Cursor pagination**: 30 customer matching, `limit=10` → primo page 10 righe + `has_more=true` + cursor; following cursor → next 10.
8. **Empty result**: `q=zzzzz` (no match) → `data: []`, `has_more: false`, no cursor.

**NOT testato** (esplicitamente):
- BR-151 PII redaction (l'endpoint è tenant-scoped, niente PII redacted da testare).
- Email matching (non-feature).
- Audit log (non-feature).

## 5. BR coverage

| BR | Status | Justification |
|---|---|---|
| BR-151 | ✅ Soddisfatto | JOIN su `customer_tenant_relations` garantisce che ogni riga ritornata sia tenant-related → PII visibile per design. Test 4.2.2 verifica esplicitamente non-leakage. |
| BR-150 | N/A | Endpoint tenant-scoped per design (vedi §6). |
| BR-153 | N/A | Niente cross-tenant return shape, niente placeholder display name. |
| BR-154 | N/A | Niente cross-tenant access surface, niente audit log richiesto. |

## 6. Non-goals (explicit YAGNI)

- **Cross-tenant search** — esplicitamente escluso. UX autocomplete con `redacted: true` shape sarebbe inutilizzabile (non si può matchare un nome redacted).
- **Email matching** — campo email NON è ricercabile via `q`. Privacy-by-default.
- **TaxCode / VAT matching** — same as above.
- **pg_trgm fuzzy / typo tolerance** — ILIKE substring sufficiente per dataset officina attuale; migration possibile in futuro senza breaking change API.
- **Full-name concat match** (`first_name || ' ' || last_name`) — YAGNI; il frontend può fare debounce + 2 token separati.
- **Relevance ordering** — `id asc` per cursor stability. Frontend può ri-ordinare lato client se necessario.
- **Customer pool auth** — solo officina pool. Use case "customer cerca altri customer" non esiste.
- **Audit log table** — nessun BR esistente lo richiede.
- **Frontend wiring** — separato (PR successivo).
- **`/v1/customers/:id` GET** — futuro endpoint, non in scope.
- **Bulk lookup `?ids=A,B,C`** — futuro YAGNI.

## 7. Performance

- `tenantRelations.some` JOIN: indice `uq_customer_tenant (tenant_id, customer_id)` rende il subquery cheap.
- ILIKE su `firstName`/`lastName`/`businessName`: seq scan O(n_customers_per_tenant). Per officina con <1000 customer, sotto 50ms. Future: indice trigram se profiling mostra hot spot.
- No N+1: una sola query `findMany` con `select` esplicito.

## 8. Operational

- **Migration**: nessuna. Schema invariato.
- **Env vars**: nessuno nuovo.
- **CDK**: nessun cambiamento.
- **Deploy**: standard CI → App Runner. Niente operator-driven step.
- **Smoke post-deploy** (manuale opzionale, non blocking):
  ```bash
  TOKEN=<idToken-officina-Giuseppe>
  curl -H "Authorization: Bearer $TOKEN" \
    "https://api.garageos.aifollyadvisor.com/v1/customers/search?q=Mario&limit=5"
  ```
  Atteso: lista customer related a tenant Giuseppe matching "Mario".

## 9. PR description checklist

- [ ] Conventional Commits title `feat(api): customers search endpoint (autocomplete officina)`
- [ ] Riferimento a Giuseppe demo / F-WEB-DEMO3 use case
- [ ] BR coverage: 151 (PII via tenant-scoping)
- [ ] Test plan: 6 unit + 8 integration
- [ ] LOC ~290 (entro budget)
- [ ] Doc APPENDICE_A_API.md aggiornato con sezione endpoint
- [ ] Cursor refactor noted come incidental DRY (motivato dal 2° consumatore)

## 10. Out of scope (tracked elsewhere)

- **Frontend wiring autocomplete**: PR successivo separato (~50-100 LOC web). Form `intervention create` consuma `/v1/customers/search` + `/v1/vehicles/search?customer=<id>`.
- **D mobile B2C scaffold**: greenfield Expo, post questo PR.
- **H2 push channel**: dopo D.
- **F Sentry SDK**: standalone, indipendente.
