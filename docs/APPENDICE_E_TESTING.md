# Appendice E — Testing Strategy

> **Documento correlato:** questo è un'appendice del documento principale `GarageOS-Specifiche.md`. Definisce la strategia di testing per garantire qualità e manutenibilità del sistema.
>
> **Versione:** v1.0 — allineata a `GarageOS-Specifiche.md` v1.2
> **Ultimo aggiornamento:** 22 aprile 2026

---

## Scopo di questo documento

Questa appendice risponde alle domande:
- **Cosa** va testato in GarageOS?
- **Come** organizziamo i test nel monorepo?
- **Quali strumenti** usiamo per ciascun tipo di test?
- **Quali criteri** di coverage e qualità applichiamo?
- **Come** testiamo regole di business, RLS multi-tenant, flussi cross-app?

Non è un tutorial sugli strumenti: si assume familiarità con Vitest, Playwright, ecc.

---

## Indice

1. [Filosofia e piramide di test](#1-filosofia-e-piramide-di-test)
2. [Strumenti per layer](#2-strumenti-per-layer)
3. [Organizzazione nel monorepo](#3-organizzazione-nel-monorepo)
4. [Unit test](#4-unit-test)
5. [Integration test](#5-integration-test)
6. [E2E test — Web](#6-e2e-test--web)
7. [E2E test — Mobile](#7-e2e-test--mobile)
8. [Test delle business rules](#8-test-delle-business-rules)
9. [Test multi-tenant e RLS](#9-test-multi-tenant-e-rls)
10. [Test data builders / factories](#10-test-data-builders--factories)
11. [Coverage target](#11-coverage-target)
12. [Manual test plan per flussi critici](#12-manual-test-plan-per-flussi-critici)
13. [CI pipeline](#13-ci-pipeline)
14. [Testing in produzione](#14-testing-in-produzione)

---

## 1. Filosofia e piramide di test

### 1.1 Principi

1. **Test is code** — i test sono trattati con la stessa cura del codice di produzione: refactoring, code review, naming chiaro
2. **Fast feedback loop** — unit test girano in <10 secondi, integration in <2 minuti, E2E in <10 minuti
3. **Determinismo** — zero flakiness tollerata. Test flaky vengono fix o rimossi, non ignorati
4. **Testing business rules esplicitamente** — ogni regola `BR-XXX` critica ha almeno un test che la verifica
5. **Testing il comportamento, non l'implementazione** — test di unit testano contratti, non dettagli interni
6. **Realismo progressivo** — unit (mock), integration (DB reale), E2E (sistema reale)

### 1.2 Piramide di test

```
              ┌─────────┐
              │  E2E    │  ~20 test (solo flussi critici)
              └─────────┘
           ┌───────────────┐
           │  Integration  │  ~200 test (API endpoint, DB)
           └───────────────┘
        ┌─────────────────────┐
        │       Unit          │  ~800+ test (business logic pura)
        └─────────────────────┘
```

**Bilanciamento target:**
- **70% unit** — veloci, molti, coprono logica business pura
- **25% integration** — più lenti ma realistici, coprono API e DB
- **5% E2E** — solo happy path dei flussi critici

**Antipatterns da evitare:**
- Troppi E2E "solo per sicurezza" → lentissimi, flaky, costosi da mantenere
- Unit test che mockano tutto → testano la sintassi, non il comportamento
- Integration test senza cleanup → test flaky, cross-contamination

### 1.3 Cosa testiamo e cosa no

**SI testiamo:**
- ✅ Business logic (calcoli, validazioni, state machines)
- ✅ API endpoint (contratti request/response, status code, error handling)
- ✅ Query Prisma complesse (con DB reale)
- ✅ RLS policies (che l'isolamento multi-tenant funzioni davvero)
- ✅ Flussi critici end-to-end (censimento veicolo, passaggio di proprietà)
- ✅ Side effects importanti (notifiche inviate, audit log creato)

**NON testiamo (o minimo):**
- ❌ Getter/setter banali
- ❌ Form React che fanno solo mapping campo → state
- ❌ Configurazione framework (fidiamoci di Fastify, React, Prisma)
- ❌ Percorsi di errore esoterici (`JSON.parse` di stringa invalida generata dal nostro codice)
- ❌ UI pixel-perfect (non usiamo visual regression testing in v1)

---

## 2. Strumenti per layer

### 2.1 Stack di testing consolidato

| Layer | Strumento | Motivazione |
|---|---|---|
| **Test runner generale** | Vitest | Veloce, API compat Jest, ottimo con TypeScript, watch mode eccellente |
| **HTTP client testing backend** | Supertest (+ Fastify `inject()`) | Integrato con Fastify, niente porta reale per unit |
| **Test DB** | Testcontainers + PostgreSQL | Container isolato per test integration |
| **Factory dati** | Fishery | Factory type-safe per entità Prisma |
| **Mock** | Vitest native (`vi.fn`, `vi.mock`) | Built-in, no dipendenze aggiuntive |
| **Assertion library** | Vitest built-in + `@testing-library/jest-dom` | |
| **E2E Web** | Playwright | Multi-browser, auto-wait, ottima DX, trace viewer |
| **E2E Mobile** | Maestro | Semplice, YAML-based, funziona bene con Expo |
| **Component test React** | Vitest + React Testing Library | Standard de facto |
| **API mocking** | MSW (Mock Service Worker) | Per test frontend che chiamano API |
| **Snapshot testing** | Vitest | Solo per output serializzabili stabili (es. PDF structure) |

### 2.2 Perché Maestro invece di Detox

**Detox** è più potente ma:
- Setup complesso (Metro bundler, simulator config)
- Manutenzione alta
- Richiede codice nativo in alcuni casi

**Maestro** è più semplice:
- Flow definiti in YAML
- Funziona out-of-the-box con Expo managed
- Sufficiente per smoke test E2E mobile

Per v1 il budget di E2E mobile è piccolo (5-8 test), Maestro è la scelta giusta.

### 2.3 Versioni richieste

Da fissare in `package.json` del workspace root:

```json
{
  "devDependencies": {
    "vitest": "^2.1.0",
    "@vitest/coverage-v8": "^2.1.0",
    "@testing-library/react": "^16.0.0",
    "@testing-library/jest-dom": "^6.6.0",
    "@testing-library/user-event": "^14.5.0",
    "@playwright/test": "^1.48.0",
    "supertest": "^7.0.0",
    "fishery": "^2.2.0",
    "msw": "^2.6.0",
    "testcontainers": "^10.13.0"
  }
}
```

---

## 3. Organizzazione nel monorepo

### 3.1 Struttura dei test per package

```
packages/
├── api/
│   ├── src/
│   │   ├── modules/
│   │   │   ├── vehicles/
│   │   │   │   ├── vehicle.service.ts
│   │   │   │   ├── vehicle.service.test.ts       ← unit test
│   │   │   │   ├── vehicle.controller.ts
│   │   │   │   └── vehicle.controller.test.ts    ← integration test
│   │   │   └── ...
│   │   └── ...
│   └── test/
│       ├── setup.ts
│       ├── helpers.ts
│       └── fixtures/
│
├── database/
│   ├── src/
│   │   └── queries/
│   │       ├── vehicle-queries.ts
│   │       └── vehicle-queries.test.ts           ← test query complesse
│   └── test/
│       ├── factories/                            ← Fishery factories
│       ├── rls.test.ts                           ← test RLS policies
│       └── setup.ts
│
├── web-app/
│   ├── src/
│   │   ├── components/
│   │   │   ├── VehicleCard.tsx
│   │   │   └── VehicleCard.test.tsx              ← component test
│   │   └── pages/
│   └── test/
│       └── helpers.ts
│
├── mobile-app/
│   ├── src/
│   │   └── ...
│   └── test/
│       └── ...
│
└── e2e/
    ├── web/
    │   ├── tests/
    │   │   ├── vehicle-registration.spec.ts
    │   │   ├── intervention-creation.spec.ts
    │   │   └── ...
    │   ├── fixtures/
    │   └── playwright.config.ts
    │
    └── mobile/
        ├── flows/
        │   ├── claim-vehicle.yaml
        │   ├── add-private-intervention.yaml
        │   └── ...
        └── maestro.config.yaml
```

### 3.2 Convenzioni naming

- **Test files**: `<nome>.test.ts` accanto al file testato (co-located)
- **E2E files**: `<flusso>.spec.ts` in `packages/e2e/`
- **Descrizione test**: stile BDD — `describe('VehicleService')` → `it('should generate garage_code on certification')`
- **Test di business rule**: nome inizia con codice regola — `it('BR-040: should reject second active ownership')`

### 3.3 Script test nel root package.json

```json
{
  "scripts": {
    "test": "vitest",
    "test:unit": "vitest run --dir packages --exclude '**/*.integration.test.ts'",
    "test:integration": "vitest run --dir packages --include '**/*.integration.test.ts'",
    "test:rls": "vitest run packages/database/test/rls.test.ts",
    "test:e2e:web": "playwright test --config packages/e2e/web/playwright.config.ts",
    "test:e2e:mobile": "maestro test packages/e2e/mobile/flows",
    "test:coverage": "vitest run --coverage",
    "test:ci": "pnpm test:unit && pnpm test:integration"
  }
}
```

---

## 4. Unit test

### 4.1 Caratteristiche

- **Zero I/O** — niente DB, niente network, niente filesystem
- **Velocità** — ogni test <100ms, totale <10 secondi
- **Isolamento** — nessuna dipendenza tra test
- **Mocking** — dipendenze esterne mockate esplicitamente

### 4.2 Cosa coprire con unit

**Priorità alta:**
- Business logic pura (calcoli, validazioni, state transitions)
- Validatori Zod (happy path + edge cases)
- Utility functions (formattatori, parser)
- Service methods con logica condizionale complessa (es. validazione km, finestra wiki)

**Priorità media:**
- Formatters/mappers tra layer (DTO ↔ entità)
- Error classes e gestione errori custom

**Da evitare:**
- Test che verificano "chiama questo metodo di Prisma" — sono test di implementazione, fragili

### 4.3 Esempio: unit test su logica BR-062 (finestra wiki)

```typescript
// packages/api/src/modules/interventions/wiki-lock.test.ts
import { describe, it, expect } from 'vitest';
import { shouldWikiBeLocked, type Intervention } from './wiki-lock';

describe('BR-062: Finestra wiki intervento', () => {
  const baseIntervention: Intervention = {
    id: 'test-id',
    createdAt: new Date('2026-04-21T10:00:00Z'),
    firstSeenByCustomerAt: null,
    wikiLockedAt: null,
  };

  it('should NOT be locked if created <48h ago and not seen by customer', () => {
    const now = new Date('2026-04-22T10:00:00Z'); // 24h dopo
    expect(shouldWikiBeLocked(baseIntervention, now)).toBe(false);
  });

  it('should be locked if created >48h ago, even if not seen', () => {
    const now = new Date('2026-04-23T11:00:00Z'); // 49h dopo
    expect(shouldWikiBeLocked(baseIntervention, now)).toBe(true);
  });

  it('should be locked if seen by customer, regardless of age', () => {
    const seen = {
      ...baseIntervention,
      firstSeenByCustomerAt: new Date('2026-04-21T15:00:00Z'),
    };
    const now = new Date('2026-04-21T16:00:00Z'); // 6h dopo ma già visto
    expect(shouldWikiBeLocked(seen, now)).toBe(true);
  });

  it('should remain locked once wikiLockedAt is set', () => {
    const locked = {
      ...baseIntervention,
      wikiLockedAt: new Date('2026-04-21T12:00:00Z'),
    };
    const now = new Date('2026-04-21T12:30:00Z');
    expect(shouldWikiBeLocked(locked, now)).toBe(true);
  });

  it('should transition to locked exactly at 48h boundary', () => {
    const now = new Date('2026-04-23T10:00:00Z'); // esattamente 48h
    expect(shouldWikiBeLocked(baseIntervention, now)).toBe(true);
  });
});
```

### 4.4 Esempio: unit test su validatore garage_code (BR-020)

```typescript
// packages/database/src/validators/common.test.ts
import { describe, it, expect } from 'vitest';
import { GarageCodeSchema } from './common';

describe('BR-020: GarageCode format', () => {
  describe('valid codes', () => {
    it.each([
      'GO-482-KXRT',
      'GO-234-ABCD',
      'GO-999-ZZZZ',
      'GO-222-HJKL',
    ])('should accept valid code: %s', (code) => {
      expect(() => GarageCodeSchema.parse(code)).not.toThrow();
    });
  });

  describe('invalid codes', () => {
    it.each([
      ['GO-012-KXRT', 'contiene 0 e 1'],
      ['GO-482-KXRI', 'contiene I'],
      ['GO-482-KXRO', 'contiene O'],
      ['GO-482-KXRQ', 'contiene Q'],
      ['GO-482-KXRU', 'contiene U'],
      ['XX-482-KXRT', 'prefisso errato'],
      ['GO-48-KXRT', 'poche cifre'],
      ['GO-4828-KXRT', 'troppe cifre'],
      ['GO-482-KXR', 'poche lettere'],
      ['go-482-kxrt', 'lowercase — validatore NON normalizza'],
      ['GO-482-KX1T', 'numeri nelle lettere'],
      ['', 'stringa vuota'],
    ])('should reject %s (%s)', (code) => {
      expect(() => GarageCodeSchema.parse(code)).toThrow();
    });
  });
});
```

---

## 5. Integration test

### 5.1 Caratteristiche

- **DB reale** — via Testcontainers (PostgreSQL isolato per test run)
- **Velocità** — <1 secondo per test, suite totale <2 minuti
- **Cleanup automatico** — ogni test parte da stato pulito (transazione rolled-back)
- **Parallelizzazione** — test indipendenti girano in parallelo

### 5.2 Setup Testcontainers

```typescript
// packages/database/test/setup.ts
import { PostgreSqlContainer, StartedPostgreSqlContainer } from 'testcontainers';
import { PrismaClient } from '@prisma/client';
import { beforeAll, afterAll, beforeEach } from 'vitest';
import { execSync } from 'child_process';

let container: StartedPostgreSqlContainer;
let prisma: PrismaClient;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:15-alpine')
    .withDatabase('garageos_test')
    .withUsername('test')
    .withPassword('test')
    .start();

  const connectionString = container.getConnectionUri();
  process.env.DATABASE_URL = connectionString;
  process.env.DIRECT_URL = connectionString;

  // Apply migrations
  execSync('pnpm prisma migrate deploy', { stdio: 'inherit' });

  // Apply RLS policies and triggers
  execSync('psql $DATABASE_URL -f sql/rls-policies.sql', { stdio: 'inherit' });
  execSync('psql $DATABASE_URL -f sql/triggers.sql', { stdio: 'inherit' });
  execSync('psql $DATABASE_URL -f sql/functions.sql', { stdio: 'inherit' });

  // Seed system data
  execSync('pnpm db:seed', { stdio: 'inherit' });

  prisma = new PrismaClient();
}, 60_000); // timeout 60s per startup container

afterAll(async () => {
  await prisma.$disconnect();
  await container.stop();
});

export { prisma };
```

### 5.3 Pattern di cleanup tra test

Due strategie, scegliere in base al caso:

**Strategia A — Transaction rollback (veloce):**

```typescript
// Per test che non fanno commit esplicito
beforeEach(async () => {
  await prisma.$executeRaw`BEGIN`;
});

afterEach(async () => {
  await prisma.$executeRaw`ROLLBACK`;
});
```

**Strategia B — Truncate tables (più sicuro ma più lento):**

```typescript
// Per test che verificano side effect persistenti
beforeEach(async () => {
  const tables = [
    'deadline_notifications', 'deadlines',
    'intervention_disputes', 'intervention_revisions', 'interventions',
    'private_interventions', 'attachments',
    'vehicle_transfers', 'vehicle_ownerships', 'vehicles',
    'customer_tenant_relations', 'customers',
    'access_logs', 'audit_logs', 'invitations', 'push_tokens',
    'users', 'locations', 'tenants',
  ];

  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE`
  );
});
```

### 5.4 Esempio: integration test endpoint

```typescript
// packages/api/src/modules/vehicles/vehicle.controller.integration.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { buildTestApp } from '../../../test/helpers';
import { TenantFactory, UserFactory, LocationFactory } from '@garageos/database/test/factories';

describe('POST /vehicles (integration)', () => {
  let app: TestApp;
  let tenant: Tenant;
  let user: User;
  let location: Location;
  let authToken: string;

  beforeEach(async () => {
    app = await buildTestApp();

    tenant = await TenantFactory.create();
    location = await LocationFactory.create({ tenantId: tenant.id, isPrimary: true });
    user = await UserFactory.create({
      tenantId: tenant.id,
      locationId: location.id,
      role: 'super_admin',
    });

    authToken = await app.generateTestJwt({
      sub: user.cognitoSub,
      tenant_id: tenant.id,
      role: 'super_admin',
    });
  });

  it('should create a new vehicle with customer and ownership', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/vehicles',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        vehicle: {
          vin: 'ZFA16900000512345',
          plate: 'AB123CD',
          make: 'Fiat',
          model: 'Panda',
          year: 2021,
          vehicleType: 'car',
          fuelType: 'petrol',
          odometerKm: 45000,
        },
        customer: {
          mode: 'create_new',
          firstName: 'Mario',
          lastName: 'Rossi',
          email: 'mario@test.it',
          isBusiness: false,
        },
        locationId: location.id,
        sendInvitationEmail: false,
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();

    // Vehicle created with garage_code
    expect(body.vehicle.garageCode).toMatch(/^GO-[2-9]{3}-[A-HJ-NPRTV-Z]{4}$/);
    expect(body.vehicle.status).toBe('certified');

    // Customer created
    expect(body.customer.email).toBe('mario@test.it');

    // Ownership created
    expect(body.ownership.vehicleId).toBe(body.vehicle.id);
    expect(body.ownership.customerId).toBe(body.customer.id);
  });

  it('should return 409 on duplicate VIN', async () => {
    // Pre-existing vehicle
    await VehicleFactory.create({ vin: 'ZFA16900000512345' });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/vehicles',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        vehicle: {
          vin: 'ZFA16900000512345', // same VIN
          plate: 'XY999ZZ',
          make: 'Fiat',
          model: 'Panda',
          year: 2021,
          vehicleType: 'car',
          fuelType: 'petrol',
          odometerKm: 0,
        },
        customer: { mode: 'create_new', firstName: 'Test', lastName: 'User', email: 't@t.it', isBusiness: false },
        locationId: location.id,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().type).toContain('duplicate_vin');
  });

  it('should reject unauthenticated request', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/vehicles',
      payload: { /* ... */ },
    });

    expect(response.statusCode).toBe(401);
  });
});
```

---

## 6. E2E test — Web

### 6.1 Scope

E2E web per flussi critici che attraversano più schermate:

**Flussi E2E Web officina (target: 8 test):**
1. Signup tenant + onboarding completo
2. Login + dashboard
3. Censimento nuovo veicolo con cliente nuovo (flusso F-OFF-102)
4. Registrazione intervento su veicolo esistente (flusso F-OFF-301)
5. Ricerca veicolo per codice/targa
6. Gestione scadenza (creazione + modifica)
7. Gestione contestazione (risposta officina)
8. Stampa tag veicolo (verifica generazione PDF)

### 6.2 Setup Playwright

```typescript
// packages/e2e/web/playwright.config.ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // In CI solo Chromium; in locale anche Firefox/Safari se serve
  ],
  webServer: {
    command: 'pnpm --filter web-app dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
```

### 6.3 Helpers riutilizzabili

```typescript
// packages/e2e/web/fixtures/auth.ts
import { test as base, Page } from '@playwright/test';

export const test = base.extend<{
  authenticatedPage: Page;
  testTenantData: { tenantId: string; adminEmail: string };
}>({
  testTenantData: async ({}, use) => {
    // Seed test data via API (più veloce che UI)
    const data = await seedTestTenant();
    await use(data);
    await cleanupTestTenant(data.tenantId);
  },

  authenticatedPage: async ({ page, testTenantData }, use) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(testTenantData.adminEmail);
    await page.getByLabel('Password').fill('TestPassword123!');
    await page.getByRole('button', { name: 'Accedi' }).click();
    await page.waitForURL('/dashboard');
    await use(page);
  },
});
```

### 6.4 Esempio E2E: censimento veicolo

```typescript
// packages/e2e/web/tests/vehicle-registration.spec.ts
import { test, expect } from '../fixtures/auth';

test('Officina censisce un nuovo veicolo con cliente', async ({ authenticatedPage: page }) => {
  // Step 1: Apri form nuovo veicolo
  await page.getByRole('button', { name: 'Nuovo veicolo' }).click();

  // Step 2: Compila dati veicolo
  await page.getByLabel('Targa').fill('AB123CD');
  await page.getByLabel('Telaio (VIN)').fill('ZFA16900000512345');
  await page.getByLabel('Marca').fill('Fiat');
  await page.getByLabel('Modello').fill('Panda');
  await page.getByLabel('Anno').fill('2021');
  await page.getByLabel('Tipo').selectOption('car');
  await page.getByLabel('Alimentazione').selectOption('petrol');
  await page.getByLabel('Km attuali').fill('45000');

  // Step 3: Dati cliente (nuovo)
  await page.getByLabel('Nome').fill('Mario');
  await page.getByLabel('Cognome').fill('Rossi');
  await page.getByLabel('Email').fill(`mario-${Date.now()}@test.it`);
  await page.getByLabel('Telefono').fill('+39 333 1234567');

  // Step 4: Salva
  await page.getByRole('button', { name: 'Salva veicolo' }).click();

  // Step 5: Verifica redirect alla scheda veicolo
  await expect(page).toHaveURL(/\/vehicles\/[a-f0-9-]+/);

  // Step 6: Verifica codice generato
  const codeElement = page.getByTestId('garage-code');
  await expect(codeElement).toBeVisible();
  await expect(codeElement).toHaveText(/^GO-[2-9]{3}-[A-HJ-NPRTV-Z]{4}$/);

  // Step 7: Verifica pulsante stampa tag disponibile
  await expect(page.getByRole('button', { name: 'Stampa tag' })).toBeVisible();
});
```

---

## 7. E2E test — Mobile

### 7.1 Scope

**Flussi E2E mobile (target: 5-8 test):**
1. Onboarding cliente + registrazione con codice
2. Visualizzazione dettaglio veicolo e timeline
3. Aggiunta intervento privato
4. Scansione QR di un tag
5. Visualizzazione audit log accessi

### 7.2 Esempio flow Maestro

```yaml
# packages/e2e/mobile/flows/claim-vehicle.yaml
appId: it.garageos.app
---
- launchApp:
    clearState: true

- tapOn: "Accedi"
- tapOn:
    id: "email-input"
- inputText: "test-customer@garageos.it"
- tapOn:
    id: "password-input"
- inputText: "TestPassword123!"
- tapOn: "Accedi"

- assertVisible: "I tuoi veicoli"

- tapOn: "Aggiungi veicolo"
- tapOn: "Inserisci codice manualmente"

- tapOn:
    id: "garage-code-input"
- inputText: "GO-482-KXRT"
- tapOn: "Aggancia veicolo"

- assertVisible: "Fiat Panda"
- assertVisible: "GO-482-KXRT"
```

### 7.3 Setup dati test per mobile

Per gli E2E mobile, serve un tenant di test con veicoli già censiti e customer invitati. Usare uno script di seed dedicato:

```typescript
// packages/e2e/mobile/setup/seed-mobile-test.ts
// Eseguito prima dei flow Maestro
// Crea tenant, user, veicolo, customer con codice GO-482-KXRT
```

---

## 8. Test delle business rules

### 8.1 Principio "una regola → almeno un test"

Per ogni regola `BR-XXX` critica in `APPENDICE_F_BUSINESS_LOGIC.md`, deve esistere **almeno un test** nel codice che la verifica esplicitamente.

**Convenzione nome test:**
```typescript
describe('BR-040 — Un solo proprietario attivo per veicolo', () => {
  it('should reject second active ownership', () => { /* ... */ });
  it('should allow new ownership after previous ended', () => { /* ... */ });
});
```

### 8.2 Tabella di copertura minima attesa

Lista delle BR per cui **è obbligatorio** avere un test in v1:

| BR | Descrizione | Tipo test | Coverage v1 |
|---|---|---|---|
| BR-001 | Unicità VIN | Integration | Obbligatorio |
| BR-005 | VIN immutabile post-certificazione | Integration | Obbligatorio |
| BR-020 | Formato garage_code | Unit | Obbligatorio |
| BR-021 | Generazione con retry | Integration | Obbligatorio |
| BR-040 | Un proprietario attivo | Integration | Obbligatorio |
| BR-042 | Claim veicolo via codice | Integration | Obbligatorio |
| BR-043 | Transfer happy path | Integration + E2E | Obbligatorio |
| BR-045 | Cosa si trasferisce/non | Integration | Obbligatorio |
| BR-047 | Un solo transfer attivo | Integration | Obbligatorio |
| BR-049 | Transfer officina-mediated single-step | Integration | Obbligatorio |
| BR-061 | Campi intervento immutabili | Integration | Obbligatorio |
| BR-062 | Finestra wiki | Unit | Obbligatorio |
| BR-066 | Annullamento intervento | Integration | Obbligatorio |
| BR-067 | Matching intervento-scadenza | Unit + Integration | Obbligatorio |
| BR-068 | Km non decrescenti | Unit + Integration | Obbligatorio |
| BR-080 | Privacy interventi privati | Integration | Obbligatorio |
| BR-101 | Scadenza dual criteria | Unit | Obbligatorio |
| BR-102 | Schedulazione notifiche | Integration | Obbligatorio |
| BR-104 | Chiusura scadenza manuale | Integration | Obbligatorio |
| BR-121 | Nessun limite temporale contestazione | Integration | SHOULD |
| BR-151 | Visibilità PII basata su relazione | Integration | Obbligatorio |
| BR-158 | Anonimizzazione diritto all'oblio | Integration | Obbligatorio |
| BR-180 | Dimensione massima allegati | Unit | Obbligatorio |
| BR-201 | Una sola location primaria | Integration | Obbligatorio |
| BR-203 | Almeno un super_admin attivo | Integration | Obbligatorio |
| BR-213 | Operator fallback PDF (deleted user → "Operatore") | Unit + Integration | Obbligatorio |
| BR-282 | Immutabilità audit log | Integration | Obbligatorio |

**Almeno 25 test business rules in v1** prima del go-live beta.

### 8.3 Template per test di BR

```typescript
// Template standard per test di business rule

describe('BR-XXX — <titolo regola>', () => {
  // Setup
  beforeEach(async () => { /* ... */ });

  // Happy path
  it('should <comportamento atteso>', async () => {
    // Arrange
    const input = buildValidInput();

    // Act
    const result = await systemUnderTest(input);

    // Assert
    expect(result).toMatchExpectedState();
  });

  // Edge case / constraint violation
  it('should reject <input che viola la regola>', async () => {
    // Arrange
    const invalidInput = buildInvalidInput();

    // Act + Assert
    await expect(systemUnderTest(invalidInput)).rejects.toThrow(/expected error/);
  });

  // Boundary test
  it('should handle boundary case <descrizione>', async () => { /* ... */ });
});
```

---

## 9. Test multi-tenant e RLS

### 9.1 Obiettivo

Verificare che l'isolamento multi-tenant funzioni correttamente a **livello database** (non solo applicativo). Un test fondamentale perché un bug in questa area può causare **data leak** tra tenant diversi.

### 9.2 Esempio: test RLS base

```typescript
// packages/database/test/rls.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { prisma, withContext } from '../src/client';
import { TenantFactory, InterventionFactory } from './factories';

describe('RLS Policies — tenant isolation', () => {
  it('should isolate interventions between tenants', async () => {
    // Arrange: due tenant con interventi
    const tenantA = await TenantFactory.create();
    const tenantB = await TenantFactory.create();

    await InterventionFactory.create({ tenantId: tenantA.id });
    await InterventionFactory.create({ tenantId: tenantA.id });
    await InterventionFactory.create({ tenantId: tenantB.id });

    // Act & Assert: tenantA vede solo i propri interventi
    await withContext({ tenantId: tenantA.id }, async (tx) => {
      const interventionsA = await tx.intervention.findMany();
      expect(interventionsA).toHaveLength(2);
      expect(interventionsA.every((i) => i.tenantId === tenantA.id)).toBe(true);
    });

    await withContext({ tenantId: tenantB.id }, async (tx) => {
      const interventionsB = await tx.intervention.findMany();
      expect(interventionsB).toHaveLength(1);
      expect(interventionsB[0].tenantId).toBe(tenantB.id);
    });
  });

  it('should NOT allow write to other tenant data', async () => {
    const tenantA = await TenantFactory.create();
    const tenantB = await TenantFactory.create();
    const interventionA = await InterventionFactory.create({ tenantId: tenantA.id });

    // Tentativo di tenantB di modificare intervento di tenantA
    await expect(
      withContext({ tenantId: tenantB.id }, async (tx) => {
        return tx.intervention.update({
          where: { id: interventionA.id },
          data: { description: 'Hacked!' },
        });
      })
    ).rejects.toThrow();

    // Verifica che il dato non sia stato toccato
    await withContext({ tenantId: tenantA.id }, async (tx) => {
      const unchanged = await tx.intervention.findUnique({ where: { id: interventionA.id } });
      expect(unchanged!.description).not.toBe('Hacked!');
    });
  });

  it('should allow admin role to bypass RLS', async () => {
    const tenantA = await TenantFactory.create();
    const tenantB = await TenantFactory.create();
    await InterventionFactory.create({ tenantId: tenantA.id });
    await InterventionFactory.create({ tenantId: tenantB.id });

    await withContext({ role: 'admin' }, async (tx) => {
      const all = await tx.intervention.findMany();
      expect(all.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('should allow cross-tenant read of certified vehicles', async () => {
    const tenantA = await TenantFactory.create();
    const tenantB = await TenantFactory.create();
    const vehicle = await VehicleFactory.create({
      status: 'certified',
      certifiedByTenantId: tenantA.id,
    });

    // Tenant B può leggere il veicolo (BR-150)
    await withContext({ tenantId: tenantB.id }, async (tx) => {
      const found = await tx.vehicle.findUnique({ where: { id: vehicle.id } });
      expect(found).not.toBeNull();
    });
  });
});
```

### 9.3 Test specifico: visibilità PII (BR-151)

```typescript
describe('BR-151 — PII customer visible only to related tenants', () => {
  it('should hide customer PII from unrelated tenant', async () => {
    const tenantA = await TenantFactory.create();
    const tenantB = await TenantFactory.create();
    const customer = await CustomerFactory.create({
      firstName: 'Mario',
      lastName: 'Rossi',
      email: 'mario@real.it',
    });

    // Solo tenantA ha relazione
    await CustomerTenantRelationFactory.create({
      tenantId: tenantA.id,
      customerId: customer.id,
    });

    // tenantB legge il customer → deve ricevere dati redacted (via logica applicativa)
    const redacted = await getCustomerForTenant(customer.id, tenantB.id);

    expect(redacted.firstName).not.toBe('Mario');
    expect(redacted.email).not.toBe('mario@real.it');
    expect(redacted.redacted).toBe(true);
  });
});
```

---

## 10. Test data builders / factories

### 10.1 Perché Fishery

Fishery permette di creare factory **type-safe** con builder pattern:

```typescript
// packages/database/test/factories/tenant.factory.ts
import { Factory } from 'fishery';
import { Tenant, TenantStatus } from '@prisma/client';
import { prisma } from '../../src/client';

export const TenantFactory = Factory.define<Tenant>(({ sequence, transientParams, onCreate }) => {
  onCreate((tenant) => prisma.tenant.create({ data: tenant }));

  return {
    id: `tenant-${sequence}-00000000-0000-0000-0000-000000000000`,
    businessName: `Officina Test ${sequence}`,
    vatNumber: `${String(sequence).padStart(11, '0')}`,
    email: `tenant-${sequence}@test.it`,
    phone: null,
    addressLine: 'Via Test 1',
    city: 'Milano',
    province: 'MI',
    postalCode: '20100',
    taxCode: null,
    logoUrl: null,
    status: 'active' as TenantStatus,
    billingStatus: 'manual',
    plan: 'starter',
    settings: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };
});

// Usage:
// const tenant = await TenantFactory.create();
// const suspendedTenant = await TenantFactory.create({ status: 'suspended' });
// const tenantData = TenantFactory.build(); // no DB write
```

### 10.2 Factory interconnesse

```typescript
// packages/database/test/factories/intervention.factory.ts
import { Factory } from 'fishery';
import { TenantFactory } from './tenant.factory';
import { LocationFactory } from './location.factory';
import { UserFactory } from './user.factory';
import { VehicleFactory } from './vehicle.factory';
import { InterventionTypeFactory } from './intervention-type.factory';

export const InterventionFactory = Factory.define<Intervention>(({ associations, onCreate }) => {
  onCreate((intervention) => prisma.intervention.create({ data: intervention }));

  return {
    // ... campi base
    tenantId: associations.tenantId ?? undefined, // build dinamico via associations
    // ...
  };
}).transient({
  async tenant() { return TenantFactory.create(); },
  async location() { return LocationFactory.create(); },
  async vehicle() { return VehicleFactory.create({ status: 'certified' }); },
});

// Usage con associazioni automatiche
const intervention = await InterventionFactory.create(); // crea tutto il grafo
```

### 10.3 Convention: factory in `packages/database/test/factories/`

Una factory per entità:
- `tenant.factory.ts`
- `location.factory.ts`
- `user.factory.ts`
- `customer.factory.ts`
- `vehicle.factory.ts`
- `intervention.factory.ts`
- `deadline.factory.ts`
- `attachment.factory.ts`
- ...

Export unificato in `packages/database/test/factories/index.ts`.

---

## 11. Coverage target

### 11.1 Target per tipo di codice

| Area | Coverage target | Motivazione |
|---|---|---|
| **Business logic (services)** | 80% | Core del sistema, bug costosi |
| **API controllers** | 70% | Testati spesso via integration |
| **Validators (Zod)** | 90% | Facili da testare, fondamentali |
| **Database queries** | 70% | Coperti da integration |
| **React components** | 50% | Coperti principalmente da E2E/manual |
| **Utility functions** | 85% | Pure, facili da testare |
| **Infrastructure code (CDK)** | 40% | Testato in staging |
| **Generated code (Prisma client)** | 0% | Non testiamo codice generato |

**Aggregato target progetto v1:** **70% coverage totale**.

### 11.2 Cosa NON conta nel coverage

Configurazione `vitest.config.ts`:

```typescript
coverage: {
  exclude: [
    '**/*.config.{ts,js}',
    '**/*.d.ts',
    '**/node_modules/**',
    '**/dist/**',
    '**/__generated__/**',
    '**/prisma/migrations/**',
    '**/test/**',
    '**/*.test.{ts,tsx}',
    '**/index.ts', // barrel files
    'packages/e2e/**',
  ],
  thresholds: {
    lines: 70,
    functions: 70,
    branches: 65,
    statements: 70,
  },
}
```

### 11.3 Come interpretare il coverage

Il coverage **non è un obiettivo in sé**. È un indicatore di rischio:
- Area con coverage basso = area più rischiosa in caso di bug
- 80% con test banali è peggio di 50% con test significativi

**Red flags durante review:**
- Test che non hanno assertion
- Test che "girano" ma non verificano nulla
- Coverage alto ma pochi test sui comportamenti edge
- Test copiati/incollati senza varianti di input

---

## 12. Manual test plan per flussi critici

### 12.1 Pre-release manual checklist

Prima di ogni rilascio major in production, eseguire **manualmente** questi scenari su ambiente staging (v1.1+) o production-candidate (v1):

#### Checklist Web Officina

- [ ] **Signup completo** — Creazione nuovo tenant, verifica email, login
- [ ] **Onboarding** — Wizard post-signup, creazione location aggiuntiva
- [ ] **Invito meccanico** — Invio invito, ricezione email, accettazione, login come meccanico
- [ ] **Censimento veicolo** — Form completo + generazione codice + stampa PDF tag
- [ ] **Ricerca veicolo** — Per codice, per targa, per VIN, per cliente
- [ ] **Intervento semplice** — Creazione, visualizzazione in timeline
- [ ] **Intervento con allegati** — Upload foto, verifica compressione server-side
- [ ] **Modifica intervento in finestra wiki** — Modifica senza revision log
- [ ] **Modifica intervento post-lock** — Verifica revision log + notifica cliente
- [ ] **Annullamento intervento** — Con motivazione, persistenza con flag
- [ ] **Scadenza creata** — Notifiche programmate in EventBridge visibili
- [ ] **Chiusura scadenza** — Via intervento matching
- [ ] **Gestione contestazione** — Ricezione notifica, risposta, visibilità
- [ ] **Audit log** — Verifica log accessi per ogni operazione
- [ ] **Ricerca cross-tenant** — Veicolo di altro tenant, PII nascoste
- [ ] **Logout + re-login** — Session handling corretto

#### Checklist Mobile Cliente

- [ ] **Download + installazione** da TestFlight / internal sharing
- [ ] **Registrazione con codice** — Da email invito
- [ ] **Claim via QR** — Scansione funziona
- [ ] **Lista veicoli** — Rendering corretto, fotografie, stati
- [ ] **Timeline veicolo** — Interventi officina + privati distinguibili
- [ ] **Intervento privato** — Creazione, modifica, cancellazione
- [ ] **Allegato a intervento privato** — Upload foto dalla galleria
- [ ] **Notifica push** — Ricezione notifica di nuovo intervento
- [ ] **Notifica scadenza** — Ricezione T-30/T-7/T-0
- [ ] **Audit accessi** — Visibilità log in-app
- [ ] **Passaggio proprietà** — Flusso completo con due account
- [ ] **Cessione veicolo** — Generazione codice temporaneo
- [ ] **Accettazione transfer** — Da account secondario
- [ ] **Share link** — Generazione, vista pubblica senza login
- [ ] **Export PDF** — Download e apertura
- [ ] **Cancellazione account** — Anonimizzazione, impossibilità login successivo

#### Checklist integrazioni

- [ ] **Email SES** — Signup, invito, promemoria, reset password
- [ ] **Push notifications Expo** — iOS + Android
- [ ] **S3 upload** — Presigned URL funzionano
- [ ] **EventBridge** — Schedulazione scadenze
- [ ] **Sentry** — Error reporting attivo (forzare un errore)
- [ ] **CloudWatch Logs** — Log strutturati visibili

### 12.2 Accessibility check manuale

- [ ] Navigazione solo tastiera sulla web app
- [ ] Screen reader VoiceOver (iOS) sulla mobile app
- [ ] Contrasto testo verificato con WCAG checker
- [ ] Zoom 200% browser non rompe layout

---

## 13. CI pipeline

### 13.1 GitHub Actions workflow

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  lint-and-typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck

  unit-tests:
    runs-on: ubuntu-latest
    needs: lint-and-typecheck
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm test:unit --coverage
      - uses: actions/upload-artifact@v4
        with:
          name: unit-coverage
          path: coverage/

  integration-tests:
    runs-on: ubuntu-latest
    needs: lint-and-typecheck
    services:
      postgres:
        image: postgres:15-alpine
        env:
          POSTGRES_PASSWORD: test
          POSTGRES_DB: garageos_test
        ports: [5432:5432]
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @garageos/database db:migrate:deploy
        env:
          DATABASE_URL: postgresql://postgres:test@localhost:5432/garageos_test
          DIRECT_URL: postgresql://postgres:test@localhost:5432/garageos_test
      - run: pnpm --filter @garageos/database db:rls:apply
        env:
          DATABASE_URL: postgresql://postgres:test@localhost:5432/garageos_test
      - run: pnpm --filter @garageos/database db:triggers:apply
        env:
          DATABASE_URL: postgresql://postgres:test@localhost:5432/garageos_test
      - run: pnpm --filter @garageos/database db:seed
        env:
          DATABASE_URL: postgresql://postgres:test@localhost:5432/garageos_test
      - run: pnpm test:integration
        env:
          DATABASE_URL: postgresql://postgres:test@localhost:5432/garageos_test
          DIRECT_URL: postgresql://postgres:test@localhost:5432/garageos_test

  e2e-web:
    runs-on: ubuntu-latest
    needs: integration-tests
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec playwright install --with-deps chromium
      - run: pnpm test:e2e:web
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-report
          path: packages/e2e/web/playwright-report/
```

### 13.2 Regole del merge

**Pull request bloccata** se:
- Lint o typecheck falliscono
- Unit o integration test falliscono
- Coverage scende sotto threshold
- E2E critici falliscono (per PR su `main`)

**PR approvabile senza E2E** per feature branch in develop (in v1.1+).

### 13.3 Pre-commit hooks (opzionale)

Via Husky + lint-staged:

```json
// package.json
{
  "husky": {
    "hooks": {
      "pre-commit": "lint-staged"
    }
  },
  "lint-staged": {
    "*.{ts,tsx}": ["eslint --fix", "prettier --write"],
    "*.{md,json}": ["prettier --write"]
  }
}
```

### 13.4 Test post-deploy in production

Dopo ogni deploy automatico su production:
- **Smoke test automatico**: chiamata a `GET /health`, verifica risposta 200
- **Synthetic check**: test E2E minimale (login + dashboard) eseguito ogni 15 minuti via Playwright schedulato
- **Rollback automatico**: se smoke fallisce 3 volte consecutive

---

## 14. Testing in produzione

### 14.1 Feature flags per rollout

Per feature rischiose (v1.1+), usare feature flags:

```typescript
// Pseudo-implementazione
const isNewFeatureEnabled = await featureFlags.isEnabled('new-transfer-flow', {
  tenantId: currentTenant.id,
});

if (isNewFeatureEnabled) {
  return newTransferFlow();
} else {
  return legacyTransferFlow();
}
```

Rollout progressivo: 1 tenant pilota → 10% → 50% → 100%.

### 14.2 Error budget e monitoring

Alert Sentry configurati per:
- Nuovo tipo di errore non visto in produzione → alert immediato
- Error rate > 1% per endpoint → alert warning
- Regressione: errore risolto in v1.0 riappare in v1.1 → alert critical

### 14.3 Canary testing

Per deploy di nuove versioni backend:
- Deploy su un solo istanza App Runner
- 10 minuti di monitoring
- Se errori: rollback automatico
- Se OK: rollout completo

Da implementare in v1.1+ quando ci sono più istanze.

---

## 15. Checklist per Claude Code

Quando sviluppa una nuova feature, Claude Code deve:

1. [ ] Leggere le **BR** pertinenti in `APPENDICE_F_BUSINESS_LOGIC.md`
2. [ ] Scrivere **unit test** per la business logic prima dell'implementazione (TDD raccomandato)
3. [ ] Aggiungere **integration test** per ogni nuovo endpoint API
4. [ ] Aggiungere **test RLS** se la feature tocca dati multi-tenant sensibili
5. [ ] Creare **factory** Fishery per ogni nuova entità di test
6. [ ] Aggiornare **manual test checklist** (sezione 12) se la feature è user-facing critica
7. [ ] Aggiungere **E2E test** solo per flussi end-to-end critici (usare la tabella di priorità)
8. [ ] Eseguire **`pnpm test:ci`** localmente prima di commit
9. [ ] Verificare coverage con **`pnpm test:coverage`** — non abbassarlo sotto la baseline del modulo

---

*Fine Appendice E — Testing Strategy*
