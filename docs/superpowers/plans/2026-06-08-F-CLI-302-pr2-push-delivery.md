# F-CLI-302 PR2 — Push delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Estendere `dispatchNotification` con un canale Expo Push accanto all'email, così che scheduler scadenze ed eventi intervento consegnino push+email (BR-250) con disattivazione token su fallimento ticket-time (BR-254).

**Architecture:** Push come canale **additivo e best-effort** dentro l'unico entry point `dispatchNotification`. Email e push sono indipendenti. Il canale push legge/scrive `push_tokens` sotto contesto **admin**: lo scheduler (già in tx admin) passa la sua `tx`; i 3 route (post-commit) passano `app` e il dispatcher apre un `withContext({role:'admin'})` breve. `DispatchResult.sent/skipped/error` resta email-driven (lo scheduler ne deriva `delivery_status`); il push è aggiunto in `result.push` solo per logging.

**Tech Stack:** Fastify + TypeScript + Prisma + Vitest. Nuova dep `expo-server-sdk`. Test API = **Vitest** (`vi`, non Jest). Expo mockato nei test via il seam `lib/notifications/expo-client.ts`.

---

## File structure

**Nuovi file (src):**
- `packages/api/src/lib/notifications/expo-client.ts` — seam lazy-singleton attorno a `expo-server-sdk` (mirror di `ses-client.ts`): chunk+send+flatten, validazione token, reset per i test.
- `packages/api/src/lib/notifications/event-preference-key.ts` — `preferenceKeyForEvent` estratto dal dispatcher (evita cicli di import; condiviso da dispatcher e push-channel).
- `packages/api/src/lib/notifications/push-templates.ts` — render puro `event → { title, body, data }` (IT, DB-free).
- `packages/api/src/lib/notifications/push-channel.ts` — `dispatchPush(...)`: gating preferenza, load token, invio Expo, BR-254.

**File modificati (src):**
- `packages/api/src/lib/notifications/types.ts` — `NotificationEventPrefKey`, `PushDispatchResult`, estensione `DispatchResult.push?`.
- `packages/api/src/lib/notifications/preferences.ts` — `isPushEnabled`.
- `packages/api/src/lib/notifications/dispatcher.ts` — input `app?`/`tx?`, canali indipendenti, fan-out push.
- `packages/api/src/lib/deadlines/scheduler-invocation.ts` — passa `app` + `tx` alla dispatch.
- `packages/api/src/routes/v1/interventions-cancel.ts` — passa `app`.
- `packages/api/src/routes/v1/interventions-update.ts` — passa `app`.
- `packages/api/src/routes/v1/vehicles-ownership-transfer.ts` — passa `app`.
- `packages/api/package.json` — dep `expo-server-sdk`.

**File modificati (test):**
- `packages/api/tests/unit/lib/notifications/expo-client.test.ts` — NUOVO.
- `packages/api/tests/unit/lib/notifications/push-templates.test.ts` — NUOVO.
- `packages/api/tests/unit/lib/notifications/preferences.test.ts` — NUOVO (`isPushEnabled`).
- `packages/api/tests/unit/lib/notifications/push-channel.test.ts` — NUOVO.
- `packages/api/tests/unit/lib/notifications/dispatcher.test.ts` — MODIFICA (fan-out push).
- `packages/api/tests/integration/push-delivery.test.ts` — NUOVO (BR-254 su Postgres reale).
- `packages/api/tests/integration/helpers.ts` — MODIFICA (helper `getCustomerAppInstalled`).

**Docs:**
- `docs/APPENDICE_C_INFRASTRUCTURE.md` — nota `EXPO_ACCESS_TOKEN` opzionale.

---

## Task 1: Dependency + Expo client seam

**Files:**
- Modify: `packages/api/package.json` (dependencies)
- Create: `packages/api/src/lib/notifications/expo-client.ts`
- Test: `packages/api/tests/unit/lib/notifications/expo-client.test.ts`

- [ ] **Step 1: Add the dependency**

Run (dalla root del repo):

```bash
pnpm --filter @garageos/api add expo-server-sdk
```

Expected: `package.json` di `packages/api` ottiene `expo-server-sdk` in `dependencies`; lockfile aggiornato. Giustificazione (per la PR description): chunking 100/msg, validazione token, classificazione errori ticket.

- [ ] **Step 2: Write the failing test**

Create `packages/api/tests/unit/lib/notifications/expo-client.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the underlying package so the seam can be exercised without network.
const sendMock = vi.fn();
vi.mock('expo-server-sdk', () => {
  class Expo {
    sendPushNotificationsAsync = sendMock;
    static isExpoPushToken(token: string): boolean {
      return typeof token === 'string' && token.startsWith('ExpoPushToken[');
    }
    // Chunk into groups of 2 so the flatten/order test is meaningful.
    static chunkPushNotifications<T>(messages: T[]): T[][] {
      const out: T[][] = [];
      for (let i = 0; i < messages.length; i += 2) out.push(messages.slice(i, i + 2));
      return out;
    }
  }
  return { Expo };
});

import {
  _resetExpoClientForTests,
  isValidExpoPushToken,
  sendExpoPushChunks,
} from '../../../../src/lib/notifications/expo-client.js';

describe('expo-client seam', () => {
  beforeEach(() => {
    _resetExpoClientForTests();
    sendMock.mockReset();
  });
  afterEach(() => {
    delete process.env.EXPO_ACCESS_TOKEN;
  });

  it('isValidExpoPushToken delegates to Expo.isExpoPushToken', () => {
    expect(isValidExpoPushToken('ExpoPushToken[abc]')).toBe(true);
    expect(isValidExpoPushToken('garbage')).toBe(false);
  });

  it('chunks, sends, and flattens tickets in input order', async () => {
    sendMock
      .mockResolvedValueOnce([{ status: 'ok', id: 't0' }, { status: 'ok', id: 't1' }])
      .mockResolvedValueOnce([{ status: 'ok', id: 't2' }]);
    const messages = [
      { to: 'a', title: 'x', body: 'y' },
      { to: 'b', title: 'x', body: 'y' },
      { to: 'c', title: 'x', body: 'y' },
    ];
    const tickets = await sendExpoPushChunks(messages as never);
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(tickets.map((t) => (t as { id: string }).id)).toEqual(['t0', 't1', 't2']);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @garageos/api test:unit -- expo-client`
Expected: FAIL — `Cannot find module '.../expo-client.js'`.

- [ ] **Step 4: Write the seam**

Create `packages/api/src/lib/notifications/expo-client.ts`:

```ts
import { Expo, type ExpoPushMessage, type ExpoPushTicket } from 'expo-server-sdk';

export type { ExpoPushMessage, ExpoPushTicket };

// Lazy singleton — mirrors lib/ses-client.ts. Tests reset it so the
// expo-server-sdk mock is re-read on each setup.
let _client: Expo | null = null;

export function getExpoClient(): Expo {
  if (_client) return _client;
  _client = new Expo(
    process.env.EXPO_ACCESS_TOKEN ? { accessToken: process.env.EXPO_ACCESS_TOKEN } : {},
  );
  return _client;
}

// Test-only reset hook. Production code never imports this.
export function _resetExpoClientForTests(): void {
  _client = null;
}

export function isValidExpoPushToken(token: string): boolean {
  return Expo.isExpoPushToken(token);
}

// Expo caps a request at 100 messages. Chunk, send each chunk sequentially,
// and flatten the tickets back in input order so ticket[i] aligns with
// message[i] (the push channel relies on this for BR-254 token mapping).
export async function sendExpoPushChunks(
  messages: ExpoPushMessage[],
): Promise<ExpoPushTicket[]> {
  const client = getExpoClient();
  const chunks = Expo.chunkPushNotifications(messages);
  const tickets: ExpoPushTicket[] = [];
  for (const chunk of chunks) {
    const chunkTickets = await client.sendPushNotificationsAsync(chunk);
    tickets.push(...chunkTickets);
  }
  return tickets;
}
```

> Note: usa l'import **named** `{ Expo }` (esportato da expo-server-sdk v3). Se il typecheck si lamenta dell'export, fallback: `import Expo from 'expo-server-sdk';` con `import type { ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';`.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @garageos/api test:unit -- expo-client`
Expected: PASS (2 test).

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @garageos/api typecheck`
Expected: nessun errore.

- [ ] **Step 7: Commit**

```bash
git add packages/api/package.json pnpm-lock.yaml packages/api/src/lib/notifications/expo-client.ts packages/api/tests/unit/lib/notifications/expo-client.test.ts
printf 'feat(api): add expo-server-sdk push client seam\n' > /tmp/cm.txt
git commit -F /tmp/cm.txt
```

---

## Task 2: Shared event→preference-key mapper

**Files:**
- Create: `packages/api/src/lib/notifications/event-preference-key.ts`
- Modify: `packages/api/src/lib/notifications/types.ts`
- Modify: `packages/api/src/lib/notifications/dispatcher.ts` (importa il mapper estratto)
- Test: `packages/api/tests/unit/lib/notifications/event-preference-key.test.ts`

- [ ] **Step 1: Add the shared key type to types.ts**

In `packages/api/src/lib/notifications/types.ts`, dopo `export type EmailEnabledKey = ...` (riga ~80) aggiungi:

```ts
// The three preference keys an event can map to. Subset of EmailEnabledKey,
// and all present in DEFAULT_NOTIFICATION_PREFERENCES.push — so it types both
// the email and push gating lookups.
export type NotificationEventPrefKey =
  | 'intervention_updates'
  | 'deadline_reminder'
  | 'ownership_transfer';
```

- [ ] **Step 2: Write the failing test**

Create `packages/api/tests/unit/lib/notifications/event-preference-key.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { preferenceKeyForEvent } from '../../../../src/lib/notifications/event-preference-key.js';
import type { NotificationEvent } from '../../../../src/lib/notifications/types.js';

const tenant = { id: 't', businessName: 'O' };

it('maps intervention.revised and cancelled to intervention_updates', () => {
  const revised: NotificationEvent = {
    type: 'intervention.revised',
    intervention: { id: 'i', vehicleId: 'v', title: null, description: null, cancelledReason: null },
    revision: { id: 'r', revisedAt: new Date(), reason: null, changes: {} },
    tenant,
  };
  const cancelled: NotificationEvent = {
    type: 'intervention.cancelled',
    intervention: { id: 'i', vehicleId: 'v', title: null, description: null, cancelledReason: null },
    tenant,
  };
  expect(preferenceKeyForEvent(revised)).toBe('intervention_updates');
  expect(preferenceKeyForEvent(cancelled)).toBe('intervention_updates');
});

it('maps deadline.reminder and ownership.transferred', () => {
  const deadline: NotificationEvent = {
    type: 'deadline.reminder',
    deadlineId: 'd',
    reminderType: 't_minus_30',
    dueDate: '2026-12-31',
    dueOdometerKm: null,
    vehicleId: 'v',
    vehicleLicensePlate: 'AB123CD',
    interventionTypeName: 'Revisione',
    description: null,
  };
  const transfer: NotificationEvent = {
    type: 'ownership.transferred',
    vehicle: { id: 'v', plate: 'AB123CD' },
    tenant,
    transferReason: 'purchase',
    transferredAt: '2026-05-22T10:30:00.000Z',
  };
  expect(preferenceKeyForEvent(deadline)).toBe('deadline_reminder');
  expect(preferenceKeyForEvent(transfer)).toBe('ownership_transfer');
});

describe('preferenceKeyForEvent', () => {
  it('is a function', () => expect(typeof preferenceKeyForEvent).toBe('function'));
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @garageos/api test:unit -- event-preference-key`
Expected: FAIL — modulo non trovato.

- [ ] **Step 4: Create the mapper module**

Create `packages/api/src/lib/notifications/event-preference-key.ts`:

```ts
import type { NotificationEvent, NotificationEventPrefKey } from './types.js';

// Maps each event type to the preference key that gates it on BOTH channels.
// intervention.* → intervention_updates; deadline.reminder → deadline_reminder;
// ownership.transferred → ownership_transfer. (Extracted from dispatcher.ts so
// push-channel can reuse it without an import cycle.)
export function preferenceKeyForEvent(event: NotificationEvent): NotificationEventPrefKey {
  switch (event.type) {
    case 'intervention.revised':
    case 'intervention.cancelled':
      return 'intervention_updates';
    case 'deadline.reminder':
      return 'deadline_reminder';
    case 'ownership.transferred':
      return 'ownership_transfer';
  }
}
```

- [ ] **Step 5: Remove the duplicate from dispatcher.ts and import the shared one**

In `packages/api/src/lib/notifications/dispatcher.ts`:

Delete the local function (righe ~38-52):

```ts
// Maps each event type to the corresponding notification preference key.
// ...
function preferenceKeyForEvent(event: NotificationEvent): EmailEnabledKey {
  switch (event.type) {
    ...
  }
}
```

Add this import alongside the others near the top (dopo l'import dei templates):

```ts
import { preferenceKeyForEvent } from './event-preference-key.js';
```

(Il tipo di ritorno passa da `EmailEnabledKey` a `NotificationEventPrefKey`, che è assegnabile a `isEmailEnabled(key: EmailEnabledKey)`.)

- [ ] **Step 6: Run tests to verify mapper + dispatcher still pass**

Run: `pnpm --filter @garageos/api test:unit -- event-preference-key dispatcher`
Expected: PASS (mapper 3 test + dispatcher 8 test invariati).

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @garageos/api typecheck`
Expected: nessun errore.

- [ ] **Step 8: Commit**

```bash
git add packages/api/src/lib/notifications/event-preference-key.ts packages/api/src/lib/notifications/types.ts packages/api/src/lib/notifications/dispatcher.ts packages/api/tests/unit/lib/notifications/event-preference-key.test.ts
printf 'refactor(api): extract preferenceKeyForEvent to shared module\n' > /tmp/cm.txt
git commit -F /tmp/cm.txt
```

---

## Task 3: Push templates

**Files:**
- Create: `packages/api/src/lib/notifications/push-templates.ts`
- Test: `packages/api/tests/unit/lib/notifications/push-templates.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/api/tests/unit/lib/notifications/push-templates.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { renderPushPayload } from '../../../../src/lib/notifications/push-templates.js';
import type { NotificationEvent } from '../../../../src/lib/notifications/types.js';

const tenant = { id: 't', businessName: 'Officina Mario' };

it('renders intervention.revised with ids in data', () => {
  const event: NotificationEvent = {
    type: 'intervention.revised',
    intervention: { id: 'int-1', vehicleId: 'veh-1', title: 'Tagliando', description: null, cancelledReason: null },
    revision: { id: 'r', revisedAt: new Date(), reason: null, changes: {} },
    tenant,
  };
  const p = renderPushPayload(event);
  expect(p.title).toMatch(/aggiornat/i);
  expect(p.body).toContain('Officina Mario');
  expect(p.data).toEqual({ type: 'intervention.revised', interventionId: 'int-1', vehicleId: 'veh-1' });
});

it('renders intervention.cancelled', () => {
  const event: NotificationEvent = {
    type: 'intervention.cancelled',
    intervention: { id: 'int-2', vehicleId: 'veh-2', title: null, description: null, cancelledReason: 'x' },
    tenant,
  };
  const p = renderPushPayload(event);
  expect(p.title).toMatch(/annullat/i);
  expect(p.data).toEqual({ type: 'intervention.cancelled', interventionId: 'int-2', vehicleId: 'veh-2' });
});

it('renders deadline.reminder with plate and type name', () => {
  const event: NotificationEvent = {
    type: 'deadline.reminder',
    deadlineId: 'd-1',
    reminderType: 't_minus_7',
    dueDate: '2026-12-31',
    dueOdometerKm: null,
    vehicleId: 'veh-3',
    vehicleLicensePlate: 'AB123CD',
    interventionTypeName: 'Revisione',
    description: null,
  };
  const p = renderPushPayload(event);
  expect(p.title).toMatch(/scadenz/i);
  expect(p.body).toContain('AB123CD');
  expect(p.body).toContain('Revisione');
  expect(p.data).toEqual({ type: 'deadline.reminder', deadlineId: 'd-1', vehicleId: 'veh-3' });
});

it('renders ownership.transferred', () => {
  const event: NotificationEvent = {
    type: 'ownership.transferred',
    vehicle: { id: 'veh-4', plate: 'XY987ZK' },
    tenant,
    transferReason: 'purchase',
    transferredAt: '2026-05-22T10:30:00.000Z',
  };
  const p = renderPushPayload(event);
  expect(p.title).toMatch(/trasferit/i);
  expect(p.body).toContain('XY987ZK');
  expect(p.data).toEqual({ type: 'ownership.transferred', vehicleId: 'veh-4' });
});

describe('renderPushPayload', () => {
  it('keeps titles short', () => {
    const event: NotificationEvent = {
      type: 'ownership.transferred',
      vehicle: { id: 'v', plate: 'AB123CD' },
      tenant,
      transferReason: 'other',
      transferredAt: '2026-05-22T10:30:00.000Z',
    };
    expect(renderPushPayload(event).title.length).toBeLessThanOrEqual(40);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/api test:unit -- push-templates`
Expected: FAIL — modulo non trovato.

- [ ] **Step 3: Implement the templates**

Create `packages/api/src/lib/notifications/push-templates.ts`:

```ts
import type { NotificationEvent } from './types.js';

// Pure title/body/data renderer for Expo push. Italian, short (title ≤ ~40,
// body ≤ ~120 char). `data` carries the routing hints the mobile app will use
// for tap-to-screen (not consumed in PR2). Mirrors the email subjects.
export interface PushPayload {
  title: string;
  body: string;
  data: Record<string, string>;
}

export function renderPushPayload(event: NotificationEvent): PushPayload {
  switch (event.type) {
    case 'intervention.revised':
      return {
        title: 'Intervento aggiornato',
        body: `${event.tenant.businessName} ha modificato un intervento sul tuo veicolo.`,
        data: {
          type: 'intervention.revised',
          interventionId: event.intervention.id,
          vehicleId: event.intervention.vehicleId,
        },
      };
    case 'intervention.cancelled':
      return {
        title: 'Intervento annullato',
        body: `${event.tenant.businessName} ha annullato un intervento sul tuo veicolo.`,
        data: {
          type: 'intervention.cancelled',
          interventionId: event.intervention.id,
          vehicleId: event.intervention.vehicleId,
        },
      };
    case 'deadline.reminder':
      return {
        title: 'Scadenza in arrivo',
        body: `${event.interventionTypeName} per ${event.vehicleLicensePlate} è in scadenza.`,
        data: {
          type: 'deadline.reminder',
          deadlineId: event.deadlineId,
          vehicleId: event.vehicleId,
        },
      };
    case 'ownership.transferred':
      return {
        title: 'Veicolo trasferito',
        body: `La proprietà del veicolo ${event.vehicle.plate} è stata trasferita.`,
        data: {
          type: 'ownership.transferred',
          vehicleId: event.vehicle.id,
        },
      };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @garageos/api test:unit -- push-templates`
Expected: PASS (5 test).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/lib/notifications/push-templates.ts packages/api/tests/unit/lib/notifications/push-templates.test.ts
printf 'feat(api): add push notification templates\n' > /tmp/cm.txt
git commit -F /tmp/cm.txt
```

---

## Task 4: isPushEnabled

**Files:**
- Modify: `packages/api/src/lib/notifications/preferences.ts`
- Test: `packages/api/tests/unit/lib/notifications/preferences.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/api/tests/unit/lib/notifications/preferences.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { isPushEnabled } from '../../../../src/lib/notifications/preferences.js';
import type { CustomerForNotification } from '../../../../src/lib/notifications/types.js';

function customer(prefs: unknown): CustomerForNotification {
  return {
    id: 'c',
    email: 'a@b.it',
    firstName: 'A',
    lastName: 'B',
    isBusiness: false,
    businessName: null,
    status: 'active',
    notificationPreferences: prefs as CustomerForNotification['notificationPreferences'],
  };
}

describe('isPushEnabled', () => {
  it('returns the BR-226 default (true) when prefs are empty', () => {
    expect(isPushEnabled(customer({}), 'intervention_updates')).toBe(true);
  });

  it('returns the BR-226 default when prefs are malformed', () => {
    expect(isPushEnabled(customer(null), 'deadline_reminder')).toBe(true);
    expect(isPushEnabled(customer([]), 'deadline_reminder')).toBe(true);
    expect(isPushEnabled(customer({ push: 'nope' }), 'deadline_reminder')).toBe(true);
  });

  it('honors an explicit false override', () => {
    expect(isPushEnabled(customer({ push: { ownership_transfer: false } }), 'ownership_transfer')).toBe(
      false,
    );
  });

  it('honors an explicit true override', () => {
    expect(isPushEnabled(customer({ push: { intervention_updates: true } }), 'intervention_updates')).toBe(
      true,
    );
  });

  it('falls back to default when the value is not a boolean', () => {
    expect(isPushEnabled(customer({ push: { deadline_reminder: 'yes' } }), 'deadline_reminder')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/api test:unit -- notifications/preferences`
Expected: FAIL — `isPushEnabled` non esportata.

- [ ] **Step 3: Implement isPushEnabled**

In `packages/api/src/lib/notifications/preferences.ts`, aggiorna l'import dei tipi e aggiungi la funzione in fondo:

Cambia la riga di import:

```ts
import type { CustomerForNotification, EmailEnabledKey } from './types.js';
```

in:

```ts
import type {
  CustomerForNotification,
  EmailEnabledKey,
  NotificationEventPrefKey,
} from './types.js';
```

Aggiungi in fondo al file:

```ts
// Push counterpart of isEmailEnabled. Reads prefs.push[key] with the same
// defensive fallback (missing/malformed/partial -> BR-226 default). In PR2
// push.* is not yet editable (F-CLI-005 PR3), so this is effectively the
// BR-226 default (true) unless the stored JSON was hand-set.
export function isPushEnabled(
  customer: CustomerForNotification,
  key: NotificationEventPrefKey,
): boolean {
  const prefs = customer.notificationPreferences;
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) {
    return DEFAULT_NOTIFICATION_PREFERENCES.push[key];
  }
  const push = (prefs as Record<string, unknown>).push;
  if (!push || typeof push !== 'object' || Array.isArray(push)) {
    return DEFAULT_NOTIFICATION_PREFERENCES.push[key];
  }
  const value = (push as Record<string, unknown>)[key];
  if (typeof value !== 'boolean') {
    return DEFAULT_NOTIFICATION_PREFERENCES.push[key];
  }
  return value;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @garageos/api test:unit -- notifications/preferences`
Expected: PASS (5 test).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @garageos/api typecheck`
Expected: nessun errore.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/lib/notifications/preferences.ts packages/api/tests/unit/lib/notifications/preferences.test.ts
printf 'feat(api): add isPushEnabled preference gate\n' > /tmp/cm.txt
git commit -F /tmp/cm.txt
```

---

## Task 5: Push channel (load + send + BR-254)

**Files:**
- Modify: `packages/api/src/lib/notifications/types.ts` (`PushDispatchResult`)
- Create: `packages/api/src/lib/notifications/push-channel.ts`
- Test: `packages/api/tests/unit/lib/notifications/push-channel.test.ts`

- [ ] **Step 1: Add PushDispatchResult to types.ts**

In `packages/api/src/lib/notifications/types.ts`, sostituisci l'interfaccia `DispatchResult` (in fondo) con:

```ts
export interface PushDispatchResult {
  attempted: number; // active, valid tokens we tried
  sent: number; // tickets with status 'ok'
  skipped?: 'pref-off' | 'no-token';
  deactivated: number; // tokens marked active=false (BR-254)
  appInstalledCleared: boolean; // true when the last active token died -> app_installed=false
  error?: string; // channel-level send failure (whole batch)
}

export interface DispatchResult {
  // EMAIL outcome — semantics unchanged (scheduler derives delivery_status).
  sent: boolean;
  skipped?: 'pref-off' | 'no-recipient' | 'invalid-email';
  error?: string;
  // PUSH outcome — additive, best-effort, logging-only. Present only when a
  // DB context (tx or app) was supplied to dispatchNotification.
  push?: PushDispatchResult;
}
```

- [ ] **Step 2: Write the failing test**

Create `packages/api/tests/unit/lib/notifications/push-channel.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaClient } from '@garageos/database';
import { dispatchPush, type AdminRunner } from '../../../../src/lib/notifications/push-channel.js';
import type {
  CustomerForNotification,
  NotificationEvent,
} from '../../../../src/lib/notifications/types.js';

const sendMock = vi.fn();
vi.mock('../../../../src/lib/notifications/expo-client.js', () => ({
  sendExpoPushChunks: (msgs: unknown) => sendMock(msgs),
  isValidExpoPushToken: (t: string) => t.startsWith('ExpoPushToken['),
}));

const fakeLogger = {
  info: vi.fn(),
  error: vi.fn(),
} as unknown as Parameters<typeof dispatchPush>[0]['logger'];

const event: NotificationEvent = {
  type: 'deadline.reminder',
  deadlineId: 'd',
  reminderType: 't_minus_30',
  dueDate: '2026-12-31',
  dueOdometerKm: null,
  vehicleId: 'v',
  vehicleLicensePlate: 'AB123CD',
  interventionTypeName: 'Revisione',
  description: null,
};

function recipient(prefs: object = {}): CustomerForNotification {
  return {
    id: 'cust-1',
    email: 'a@b.it',
    firstName: 'A',
    lastName: 'B',
    isBusiness: false,
    businessName: null,
    status: 'active',
    notificationPreferences: prefs as CustomerForNotification['notificationPreferences'],
  };
}

// Fake tx exposing only pushToken + customer delegates the channel touches.
function makeTx(tokens: Array<{ id: string; expoPushToken: string }>) {
  const updateMany = vi.fn().mockResolvedValue({ count: 0 });
  const count = vi.fn();
  const customerUpdate = vi.fn().mockResolvedValue({});
  const tx = {
    pushToken: {
      findMany: vi.fn().mockResolvedValue(tokens),
      updateMany,
      count,
    },
    customer: { update: customerUpdate },
  };
  const run: AdminRunner = (fn) => fn(tx as unknown as PrismaClient);
  return { tx, run, updateMany, count, customerUpdate };
}

beforeEach(() => {
  sendMock.mockReset();
  vi.clearAllMocks();
});

describe('dispatchPush', () => {
  it('skips with pref-off when the push preference is disabled', async () => {
    const { run } = makeTx([{ id: 'p1', expoPushToken: 'ExpoPushToken[a]' }]);
    const res = await dispatchPush({
      event,
      recipient: recipient({ push: { deadline_reminder: false } }),
      run,
      logger: fakeLogger,
    });
    expect(res).toEqual({ attempted: 0, sent: 0, skipped: 'pref-off', deactivated: 0, appInstalledCleared: false });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('skips with no-token when the customer has no active tokens', async () => {
    const { run } = makeTx([]);
    const res = await dispatchPush({ event, recipient: recipient(), run, logger: fakeLogger });
    expect(res.skipped).toBe('no-token');
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('sends to all valid tokens and counts oks', async () => {
    const { run } = makeTx([
      { id: 'p1', expoPushToken: 'ExpoPushToken[a]' },
      { id: 'p2', expoPushToken: 'ExpoPushToken[b]' },
    ]);
    sendMock.mockResolvedValue([
      { status: 'ok', id: 't1' },
      { status: 'ok', id: 't2' },
    ]);
    const res = await dispatchPush({ event, recipient: recipient(), run, logger: fakeLogger });
    expect(res).toMatchObject({ attempted: 2, sent: 2, deactivated: 0, appInstalledCleared: false });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('BR-254: deactivates a DeviceNotRegistered token, keeps the other', async () => {
    const { run, updateMany, count, customerUpdate } = makeTx([
      { id: 'p1', expoPushToken: 'ExpoPushToken[a]' },
      { id: 'p2', expoPushToken: 'ExpoPushToken[b]' },
    ]);
    sendMock.mockResolvedValue([
      { status: 'ok', id: 't1' },
      { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
    ]);
    count.mockResolvedValue(1); // one token still active afterwards
    const res = await dispatchPush({ event, recipient: recipient(), run, logger: fakeLogger });
    expect(updateMany).toHaveBeenCalledWith({ where: { id: { in: ['p2'] } }, data: { active: false } });
    expect(customerUpdate).not.toHaveBeenCalled();
    expect(res).toMatchObject({ attempted: 2, sent: 1, deactivated: 1, appInstalledCleared: false });
  });

  it('BR-254: clears app_installed when the last active token dies', async () => {
    const { run, count, customerUpdate } = makeTx([{ id: 'p1', expoPushToken: 'ExpoPushToken[a]' }]);
    sendMock.mockResolvedValue([
      { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
    ]);
    count.mockResolvedValue(0); // no active tokens left
    const res = await dispatchPush({ event, recipient: recipient(), run, logger: fakeLogger });
    expect(customerUpdate).toHaveBeenCalledWith({ where: { id: 'cust-1' }, data: { appInstalled: false } });
    expect(res).toMatchObject({ deactivated: 1, appInstalledCleared: true });
  });

  it('captures a send failure into result.error without throwing', async () => {
    const { run, updateMany } = makeTx([{ id: 'p1', expoPushToken: 'ExpoPushToken[a]' }]);
    sendMock.mockRejectedValue(new Error('Expo down'));
    const res = await dispatchPush({ event, recipient: recipient(), run, logger: fakeLogger });
    expect(res).toMatchObject({ attempted: 1, sent: 0, deactivated: 0, error: 'Expo down' });
    expect(updateMany).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @garageos/api test:unit -- push-channel`
Expected: FAIL — modulo non trovato.

- [ ] **Step 4: Implement the push channel**

Create `packages/api/src/lib/notifications/push-channel.ts`:

```ts
import type { PrismaClient } from '@garageos/database';
import type { FastifyBaseLogger } from 'fastify';

import { preferenceKeyForEvent } from './event-preference-key.js';
import { isValidExpoPushToken, sendExpoPushChunks, type ExpoPushMessage } from './expo-client.js';
import { isPushEnabled } from './preferences.js';
import { renderPushPayload } from './push-templates.js';
import type { CustomerForNotification, NotificationEvent, PushDispatchResult } from './types.js';

// Loose tx — only the delegates the push channel reads/writes.
type PushTxLike = Pick<PrismaClient, 'pushToken' | 'customer'>;

// Runs a unit of push-token DB work under an admin RLS context. The scheduler
// passes its existing admin tx; routes pass an opener backed by
// app.withContext({role:'admin'}). Keeps the Expo HTTP call inside whatever
// context the caller already established (same boundary as the email send).
export type AdminRunner = <T>(fn: (tx: PushTxLike) => Promise<T>) => Promise<T>;

// Expo ticket-time errors that mean "this token is dead" (BR-254). Receipt-
// polling (the async second phase) is deferred to a dedicated PR.
const DEAD_TOKEN_ERRORS = new Set(['DeviceNotRegistered', 'InvalidCredentials']);

// Best-effort push delivery. NEVER throws — every failure is captured into the
// returned PushDispatchResult. Email and push are independent (BR-250).
export async function dispatchPush(input: {
  event: NotificationEvent;
  recipient: CustomerForNotification;
  run: AdminRunner;
  logger: FastifyBaseLogger;
}): Promise<PushDispatchResult> {
  const { event, recipient, run, logger } = input;
  const key = preferenceKeyForEvent(event);

  if (!isPushEnabled(recipient, key)) {
    return { attempted: 0, sent: 0, skipped: 'pref-off', deactivated: 0, appInstalledCleared: false };
  }

  return run(async (tx) => {
    const tokens = await tx.pushToken.findMany({
      where: { customerId: recipient.id, active: true },
      select: { id: true, expoPushToken: true },
    });
    const valid = tokens.filter((t) => isValidExpoPushToken(t.expoPushToken));
    if (valid.length === 0) {
      return {
        attempted: 0,
        sent: 0,
        skipped: 'no-token' as const,
        deactivated: 0,
        appInstalledCleared: false,
      };
    }

    const payload = renderPushPayload(event);
    const messages: ExpoPushMessage[] = valid.map((t) => ({
      to: t.expoPushToken,
      title: payload.title,
      body: payload.body,
      data: payload.data,
      sound: 'default',
    }));

    let tickets;
    try {
      tickets = await sendExpoPushChunks(messages);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error({
        push: { event: event.type, recipientId: recipient.id, result: 'error', error },
      });
      return { attempted: valid.length, sent: 0, deactivated: 0, appInstalledCleared: false, error };
    }

    // tickets[i] aligns with valid[i] (sendExpoPushChunks preserves order).
    let sent = 0;
    const deadTokenIds: string[] = [];
    tickets.forEach((ticket, i) => {
      if (ticket.status === 'ok') {
        sent += 1;
      } else if (ticket.details?.error && DEAD_TOKEN_ERRORS.has(ticket.details.error)) {
        deadTokenIds.push(valid[i]!.id);
      }
    });

    let appInstalledCleared = false;
    if (deadTokenIds.length > 0) {
      await tx.pushToken.updateMany({
        where: { id: { in: deadTokenIds } },
        data: { active: false },
      });
      const remaining = await tx.pushToken.count({
        where: { customerId: recipient.id, active: true },
      });
      if (remaining === 0) {
        await tx.customer.update({
          where: { id: recipient.id },
          data: { appInstalled: false },
        });
        appInstalledCleared = true;
      }
    }

    logger.info({
      push: {
        event: event.type,
        recipientId: recipient.id,
        result: 'sent',
        attempted: valid.length,
        sent,
        deactivated: deadTokenIds.length,
        appInstalledCleared,
      },
    });
    return { attempted: valid.length, sent, deactivated: deadTokenIds.length, appInstalledCleared };
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @garageos/api test:unit -- push-channel`
Expected: PASS (6 test).

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @garageos/api typecheck`
Expected: nessun errore.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/lib/notifications/types.ts packages/api/src/lib/notifications/push-channel.ts packages/api/tests/unit/lib/notifications/push-channel.test.ts
printf 'feat(api): add push delivery channel with BR-254 deactivation\n' > /tmp/cm.txt
git commit -F /tmp/cm.txt
```

---

## Task 6: Dispatcher fan-out (email + push, independent)

**Files:**
- Modify: `packages/api/src/lib/notifications/dispatcher.ts`
- Test: `packages/api/tests/unit/lib/notifications/dispatcher.test.ts` (aggiunge i test push)

- [ ] **Step 1: Write the failing tests (push fan-out)**

In `packages/api/tests/unit/lib/notifications/dispatcher.test.ts`, aggiungi in cima agli import:

```ts
import type { PrismaClient } from '@garageos/database';
```

e subito dopo gli import esistenti, il mock del canale push + un fake `app`:

```ts
const dispatchPushMock = vi.fn();
vi.mock('../../../../src/lib/notifications/push-channel.js', () => ({
  dispatchPush: (args: unknown) => dispatchPushMock(args),
}));

// Fake app whose withContext just runs the callback with a dummy tx — the
// push channel is mocked, so the tx is never really used.
function fakeApp() {
  return {
    withContext: <T>(_ctx: unknown, fn: (tx: PrismaClient) => Promise<T>) =>
      fn({} as PrismaClient),
  };
}
```

Aggiungi un nuovo `describe` in fondo al file:

```ts
describe('dispatchNotification — push fan-out', () => {
  beforeEach(() => {
    sesMock.reset();
    _resetSesClientForTests();
    vi.clearAllMocks();
    dispatchPushMock.mockReset();
    process.env.SES_FROM_ADDRESS = 'noreply@garageos.test';
    process.env.SES_CONFIGURATION_SET = 'test-config-set';
  });

  it('does NOT attempt push when neither app nor tx is provided', async () => {
    sesMock.on(SendEmailCommand).resolves({ MessageId: 'm' });
    const result = await dispatchNotification({
      event: revisedEvent,
      recipient: baseRecipient,
      logger: fakeLogger,
    });
    expect(result.push).toBeUndefined();
    expect(dispatchPushMock).not.toHaveBeenCalled();
  });

  it('attempts push (via app) even when email is preference-off', async () => {
    dispatchPushMock.mockResolvedValue({
      attempted: 1,
      sent: 1,
      deactivated: 0,
      appInstalledCleared: false,
    });
    const recipient = {
      ...baseRecipient,
      notificationPreferences: { email: { intervention_updates: false } },
    };
    const result = await dispatchNotification({
      event: revisedEvent,
      recipient,
      logger: fakeLogger,
      app: fakeApp(),
    });
    expect(result.sent).toBe(false);
    expect(result.skipped).toBe('pref-off');
    expect(dispatchPushMock).toHaveBeenCalledTimes(1);
    expect(result.push).toEqual({ attempted: 1, sent: 1, deactivated: 0, appInstalledCleared: false });
  });

  it('sends both channels when both are enabled', async () => {
    sesMock.on(SendEmailCommand).resolves({ MessageId: 'm' });
    dispatchPushMock.mockResolvedValue({
      attempted: 2,
      sent: 2,
      deactivated: 0,
      appInstalledCleared: false,
    });
    const result = await dispatchNotification({
      event: revisedEvent,
      recipient: baseRecipient,
      logger: fakeLogger,
      app: fakeApp(),
    });
    expect(result.sent).toBe(true);
    expect(result.push?.sent).toBe(2);
  });

  it('email success is unaffected when the push channel rejects', async () => {
    sesMock.on(SendEmailCommand).resolves({ MessageId: 'm' });
    dispatchPushMock.mockRejectedValue(new Error('boom'));
    const result = await dispatchNotification({
      event: revisedEvent,
      recipient: baseRecipient,
      logger: fakeLogger,
      app: fakeApp(),
    });
    expect(result.sent).toBe(true);
    expect(result.push?.error).toMatch(/boom/);
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm --filter @garageos/api test:unit -- notifications/dispatcher`
Expected: FAIL — `dispatchNotification` ignora `app`/`push` (i 4 nuovi test falliscono; i 8 esistenti passano).

- [ ] **Step 3: Rewrite dispatcher.ts with independent channels + fan-out**

Replace the entire contents of `packages/api/src/lib/notifications/dispatcher.ts` with:

```ts
import type { PrismaClient } from '@garageos/database';
import type { FastifyBaseLogger } from 'fastify';

import { sendEmail } from './email-channel.js';
import { preferenceKeyForEvent } from './event-preference-key.js';
import { isEmailEnabled } from './preferences.js';
import { dispatchPush, type AdminRunner } from './push-channel.js';
import {
  renderDeadlineReminderHtml,
  renderDeadlineReminderSubject,
  renderDeadlineReminderText,
} from './templates/deadline-reminder.js';
import {
  CANCELLATION_EMAIL_SUBJECT,
  renderCancellationEmailHtml,
  renderCancellationEmailText,
} from './templates/intervention-cancelled.js';
import {
  REVISION_EMAIL_SUBJECT,
  renderRevisionEmailHtml,
  renderRevisionEmailText,
} from './templates/intervention-revised.js';
import {
  OWNERSHIP_TRANSFERRED_SUBJECT,
  renderOwnershipTransferredHtml,
  renderOwnershipTransferredText,
} from './templates/ownership-transferred.js';
import type {
  CustomerForNotification,
  DispatchResult,
  NotificationEvent,
  PushDispatchResult,
} from './types.js';

// Structural subset of FastifyInstance (and scheduler AppLike): just the
// withContext decorator the dispatcher needs to open an admin context for push
// when the caller is NOT already inside one.
interface DispatcherAppLike {
  withContext: <T>(
    ctx: { role?: 'admin' | 'user'; tenantId?: string; customerId?: string },
    fn: (tx: PrismaClient) => Promise<T>,
  ) => Promise<T>;
}

interface DispatchInput {
  event: NotificationEvent;
  recipient: CustomerForNotification;
  logger: FastifyBaseLogger;
  // Push context. Routes pass `app` (post-commit, no open tx) → the push
  // channel opens its own admin context. The scheduler passes `tx` (its open
  // admin tx) to reuse it. When neither is provided, push is skipped entirely
  // (back-compat for email-only callers and unit tests).
  app?: DispatcherAppLike;
  tx?: PrismaClient;
}

type EmailOutcome = Pick<DispatchResult, 'sent' | 'skipped' | 'error'>;

// CONTRACT: dispatchNotification NEVER throws. All errors are captured into the
// returned DispatchResult and logged. Email and push are dispatched
// independently (BR-250): one being off/failing never suppresses the other.
export async function dispatchNotification(input: DispatchInput): Promise<DispatchResult> {
  const { event, recipient, logger, app, tx } = input;
  const prefKey = preferenceKeyForEvent(event);

  const email = await dispatchEmail({ event, recipient, logger, prefKey });

  // Push runs only when a DB context is available.
  const run: AdminRunner | null = tx
    ? (fn) => fn(tx)
    : app
      ? (fn) => app.withContext({ role: 'admin' }, fn)
      : null;

  let push: PushDispatchResult | undefined;
  if (run) {
    try {
      push = await dispatchPush({ event, recipient, run, logger });
    } catch (err) {
      // dispatchPush is best-effort and should not throw, but the contract is
      // enforced here too so a push failure never breaks the email result.
      const error = err instanceof Error ? err.message : String(err);
      logger.error({
        push: { event: event.type, recipientId: recipient.id, result: 'error', error },
      });
      push = { attempted: 0, sent: 0, deactivated: 0, appInstalledCleared: false, error };
    }
  }

  return push ? { ...email, push } : email;
}

async function dispatchEmail(args: {
  event: NotificationEvent;
  recipient: CustomerForNotification;
  logger: FastifyBaseLogger;
  prefKey: ReturnType<typeof preferenceKeyForEvent>;
}): Promise<EmailOutcome> {
  const { event, recipient, logger, prefKey } = args;

  if (!isEmailEnabled(recipient, prefKey)) {
    logger.info({
      notification: {
        event: event.type,
        recipientId: recipient.id,
        result: 'skipped',
        reason: 'pref-off',
      },
    });
    return { sent: false, skipped: 'pref-off' };
  }

  let subject: string;
  let html: string;
  let text: string;

  switch (event.type) {
    case 'intervention.revised':
      subject = REVISION_EMAIL_SUBJECT;
      html = renderRevisionEmailHtml({
        recipient,
        intervention: event.intervention,
        revision: event.revision,
        tenant: event.tenant,
      });
      text = renderRevisionEmailText({
        recipient,
        intervention: event.intervention,
        revision: event.revision,
        tenant: event.tenant,
      });
      break;
    case 'intervention.cancelled':
      subject = CANCELLATION_EMAIL_SUBJECT;
      html = renderCancellationEmailHtml({
        recipient,
        intervention: event.intervention,
        tenant: event.tenant,
      });
      text = renderCancellationEmailText({
        recipient,
        intervention: event.intervention,
        tenant: event.tenant,
      });
      break;
    case 'deadline.reminder':
      subject = renderDeadlineReminderSubject(event);
      html = renderDeadlineReminderHtml({ recipient, event });
      text = renderDeadlineReminderText({ recipient, event });
      break;
    case 'ownership.transferred':
      subject = OWNERSHIP_TRANSFERRED_SUBJECT;
      html = renderOwnershipTransferredHtml({
        recipient,
        vehicle: event.vehicle,
        tenant: event.tenant,
        transferReason: event.transferReason,
        transferredAt: event.transferredAt,
      });
      text = renderOwnershipTransferredText({
        recipient,
        vehicle: event.vehicle,
        tenant: event.tenant,
        transferReason: event.transferReason,
        transferredAt: event.transferredAt,
      });
      break;
  }

  try {
    await sendEmail({ toAddress: recipient.email, subject, html, text });
    logger.info({
      notification: { event: event.type, recipientId: recipient.id, result: 'sent' },
    });
    return { sent: true };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error({
      notification: {
        event: event.type,
        recipientId: recipient.id,
        result: 'error',
        error: errorMessage,
      },
    });
    return { sent: false, error: errorMessage };
  }
}
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `pnpm --filter @garageos/api test:unit -- notifications/dispatcher`
Expected: PASS (8 esistenti + 4 nuovi).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @garageos/api typecheck`
Expected: nessun errore.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/lib/notifications/dispatcher.ts packages/api/tests/unit/lib/notifications/dispatcher.test.ts
printf 'feat(api): fan out notifications to push alongside email\n' > /tmp/cm.txt
git commit -F /tmp/cm.txt
```

---

## Task 7: Wire the call sites

**Files:**
- Modify: `packages/api/src/lib/deadlines/scheduler-invocation.ts:140-154`
- Modify: `packages/api/src/routes/v1/interventions-cancel.ts:186-200`
- Modify: `packages/api/src/routes/v1/interventions-update.ts:276-296`
- Modify: `packages/api/src/routes/v1/vehicles-ownership-transfer.ts:228-238`

- [ ] **Step 1: Scheduler — pass app + tx**

In `packages/api/src/lib/deadlines/scheduler-invocation.ts`, nella chiamata `dispatchNotification` (dentro la `withContext({role:'admin'})`, la variabile `tx` è in scope), aggiungi `app` e `tx`:

```ts
    const dispatchResult = await dispatchNotification({
      event: {
        type: 'deadline.reminder',
        deadlineId: deadline.id,
        reminderType: detail.reminderType,
        dueDate: dueDateIso,
        dueOdometerKm: deadline.dueOdometerKm,
        vehicleId: deadline.vehicle.id,
        vehicleLicensePlate: deadline.vehicle.plate,
        interventionTypeName: deadline.interventionType.nameIt,
        description: deadline.description,
      },
      recipient,
      logger: app.log,
      app,
      tx,
    });
```

(`tx` viene riusata dal canale push → niente nuovo contesto annidato; `app` è innocuo ma passato per coerenza.)

- [ ] **Step 2: interventions-cancel — pass app**

In `packages/api/src/routes/v1/interventions-cancel.ts`, nella chiamata `dispatchNotification` (riga ~186), aggiungi `app,` accanto a `logger`:

```ts
        await dispatchNotification({
          event: {
            type: 'intervention.cancelled',
            intervention: {
              id: result.intervention.id,
              vehicleId: result.intervention.vehicleId,
              title: result.intervention.title,
              description: result.intervention.description,
              cancelledReason: result.intervention.cancelledReason,
            },
            tenant: result.tenantRow,
          },
          recipient: result.recipient,
          logger: request.log,
          app,
        });
```

- [ ] **Step 3: interventions-update — pass app**

In `packages/api/src/routes/v1/interventions-update.ts`, nella chiamata `dispatchNotification` (riga ~276), aggiungi `app,` accanto a `logger: request.log,`:

```ts
          recipient: result.recipient,
          logger: request.log,
          app,
        });
```

- [ ] **Step 4: vehicles-ownership-transfer — pass app**

In `packages/api/src/routes/v1/vehicles-ownership-transfer.ts`, nella chiamata `dispatchNotification` (riga ~228), aggiungi `app,` accanto a `logger: request.log,`:

```ts
          recipient: result.previousOwner,
          logger: request.log,
          app,
        });
```

- [ ] **Step 5: Run the affected unit suites**

Run: `pnpm --filter @garageos/api test:unit -- scheduler-invocation interventions-cancel interventions-update vehicles-ownership-transfer`
Expected: PASS. (Lo scheduler test mocka `dispatchNotification` e non asserisce gli argomenti → invariato. I route test mockano il dispatcher allo stesso modo.)

- [ ] **Step 6: Typecheck the whole repo**

Run: `pnpm -r typecheck`
Expected: nessun errore.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/lib/deadlines/scheduler-invocation.ts packages/api/src/routes/v1/interventions-cancel.ts packages/api/src/routes/v1/interventions-update.ts packages/api/src/routes/v1/vehicles-ownership-transfer.ts
printf 'feat(api): pass push context to dispatch call sites\n' > /tmp/cm.txt
git commit -F /tmp/cm.txt
```

---

## Task 8: Integration test (BR-254 on real Postgres)

**Files:**
- Modify: `packages/api/tests/integration/helpers.ts` (helper `getCustomerAppInstalled`)
- Create: `packages/api/tests/integration/push-delivery.test.ts`

> Nota CLAUDE.md: gli integration test **non** si eseguono in locale (Docker/Testcontainers freezano la macchina) — si scrivono e si delegano alla CI. Questo task crea il file e lo lascia validare a GitHub Actions.

- [ ] **Step 1: Add the app_installed reader helper**

In `packages/api/tests/integration/helpers.ts`, dopo `getPushTokens` (riga ~242), aggiungi:

```ts
export async function getCustomerAppInstalled(customerId: string): Promise<boolean> {
  const { rows } = await pgAdmin.query<{ app_installed: boolean }>(
    `SELECT app_installed FROM customers WHERE id = $1`,
    [customerId],
  );
  return rows[0]!.app_installed;
}
```

- [ ] **Step 2: Write the integration test**

Create `packages/api/tests/integration/push-delivery.test.ts`:

```ts
import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildTestServer } from './fixtures.js';
import {
  createCustomer,
  createPushToken,
  getCustomerAppInstalled,
  getPushTokens,
  resetDb,
} from './helpers.js';

// Mock the Expo seam so no real HTTP leaves the test. The push channel imports
// from expo-client.js; here we control the tickets it sees.
const sendMock = vi.fn();
vi.mock('../../src/lib/notifications/expo-client.js', () => ({
  sendExpoPushChunks: (msgs: unknown[]) => sendMock(msgs),
  isValidExpoPushToken: (t: string) => t.startsWith('ExpoPushToken['),
}));

import { dispatchNotification } from '../../src/lib/notifications/dispatcher.js';
import type { CustomerForNotification, NotificationEvent } from '../../src/lib/notifications/types.js';

const event: NotificationEvent = {
  type: 'deadline.reminder',
  deadlineId: randomUUID(),
  reminderType: 't_minus_30',
  dueDate: '2026-12-31',
  dueOdometerKm: null,
  vehicleId: randomUUID(),
  vehicleLicensePlate: 'AB123CD',
  interventionTypeName: 'Revisione',
  description: null,
};

describe('Push delivery (F-CLI-302 PR2, BR-254)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestServer();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
    sendMock.mockReset();
    // Email path needs SES env to exist; the integration build may already set
    // them. Guard so the email send fails fast and harmlessly (push is the SUT).
    process.env.SES_FROM_ADDRESS ??= 'noreply@garageos.test';
    process.env.SES_CONFIGURATION_SET ??= 'test-config-set';
  });

  function recipient(customerId: string): CustomerForNotification {
    return {
      id: customerId,
      email: 'a@b.it',
      firstName: 'A',
      lastName: 'B',
      isBusiness: false,
      businessName: null,
      status: 'active',
      notificationPreferences: {},
    };
  }

  it('reads active tokens under admin context and reports them sent', async () => {
    const { customerId } = await createCustomer({});
    await createPushToken({ customerId, expoPushToken: 'ExpoPushToken[live-1]', deviceName: 'A' });
    await createPushToken({ customerId, expoPushToken: 'ExpoPushToken[live-2]', deviceName: 'B' });
    sendMock.mockResolvedValue([
      { status: 'ok', id: 't1' },
      { status: 'ok', id: 't2' },
    ]);

    const result = await dispatchNotification({
      event,
      recipient: recipient(customerId),
      logger: app.log,
      app,
    });

    expect(result.push).toMatchObject({ attempted: 2, sent: 2, deactivated: 0 });
    const rows = await getPushTokens(customerId);
    expect(rows.every((r) => r.active)).toBe(true);
  });

  it('BR-254: persists active=false for a DeviceNotRegistered token', async () => {
    const { customerId } = await createCustomer({});
    const live = await createPushToken({ customerId, expoPushToken: 'ExpoPushToken[ok]', deviceName: 'A' });
    const dead = await createPushToken({ customerId, expoPushToken: 'ExpoPushToken[dead]', deviceName: 'B' });
    sendMock.mockResolvedValue([
      { status: 'ok', id: 't1' },
      { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
    ]);

    const result = await dispatchNotification({
      event,
      recipient: recipient(customerId),
      logger: app.log,
      app,
    });

    expect(result.push).toMatchObject({ attempted: 2, sent: 1, deactivated: 1 });
    const rows = await getPushTokens(customerId);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.active]));
    expect(byId[live.id]).toBe(true);
    expect(byId[dead.id]).toBe(false);
    expect(await getCustomerAppInstalled(customerId)).toBe(true); // one token still alive
  });

  it('BR-254: clears app_installed when the last active token dies', async () => {
    const { customerId } = await createCustomer({});
    // app_installed starts true (PR1 sets it on registration); seed it true.
    await createPushToken({ customerId, expoPushToken: 'ExpoPushToken[only]', deviceName: 'A' });
    sendMock.mockResolvedValue([
      { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
    ]);

    await dispatchNotification({ event, recipient: recipient(customerId), logger: app.log, app });

    const rows = await getPushTokens(customerId);
    expect(rows.every((r) => !r.active)).toBe(true);
    expect(await getCustomerAppInstalled(customerId)).toBe(false);
  });
});
```

> Nota: `createCustomer` crea la riga con `app_installed` al suo default DB. Se il default non è `true`, la terza asserzione del secondo test (`getCustomerAppInstalled === true`) verifica solo che NON sia stato azzerato — è comunque corretta perché resta ≥1 token attivo (il ramo che azzera non scatta). Il terzo test parte con `app_installed` qualunque e verifica il passaggio a `false`.

- [ ] **Step 3: Commit (validazione su CI)**

```bash
git add packages/api/tests/integration/helpers.ts packages/api/tests/integration/push-delivery.test.ts
printf 'test(api): integration coverage for push delivery BR-254\n' > /tmp/cm.txt
git commit -F /tmp/cm.txt
```

---

## Task 9: Docs + final gate + push

**Files:**
- Modify: `docs/APPENDICE_C_INFRASTRUCTURE.md`

- [ ] **Step 1: Document the optional env var**

In `docs/APPENDICE_C_INFRASTRUCTURE.md`, nella sezione delle variabili d'ambiente dell'API (cerca `SES_FROM_ADDRESS` per trovare il punto giusto), aggiungi una riga:

```markdown
| `EXPO_ACCESS_TOKEN` | No | Token di accesso Expo Push. **Opzionale**: se assente, l'invio push usa l'endpoint Expo standard (nessuna autenticazione enhanced). Da iniettare via secret solo se si abilita "Enhanced Security for Push Notifications" sul progetto Expo. |
```

(Adatta la forma della tabella a quella già presente nel file.)

- [ ] **Step 2: Format docs with prettier**

Run: `pnpm exec prettier --write docs/APPENDICE_C_INFRASTRUCTURE.md`
Expected: nessun diff inatteso (solo riformattazione della riga aggiunta se serve).

- [ ] **Step 3: Final repo typecheck**

Run: `pnpm -r typecheck`
Expected: nessun errore.

- [ ] **Step 4: Full API unit suite (sanity)**

Run: `pnpm --filter @garageos/api test:unit`
Expected: tutte verdi (nuove suite push + esistenti). Confronta il conteggio col baseline ~846.

- [ ] **Step 5: Commit docs**

```bash
git add docs/APPENDICE_C_INFRASTRUCTURE.md
printf 'docs: document optional EXPO_ACCESS_TOKEN env\n' > /tmp/cm.txt
git commit -F /tmp/cm.txt
```

- [ ] **Step 6: Push the branch (pre-push hook runs typecheck)**

```bash
git push -u origin feat/push-delivery
```

Expected: il pre-push hook esegue `pnpm -r typecheck` (~30s) e passa; il branch arriva su GitHub.

- [ ] **Step 7: Open the PR**

```bash
gh pr create --title 'feat(api): push delivery (F-CLI-302 PR2)' --body-file <path-to-body>
```

Body (template CLAUDE.md): **What** = canale Expo Push nel dispatcher; **Why** = F-CLI-302/303, BR-250/254/157; **Implementation notes** = canali indipendenti, push best-effort, scheduler riusa tx admin / route aprono admin ctx, BR-254 solo ticket-time (receipt-polling differito), nuova dep `expo-server-sdk` giustificata; **Tests** = unit (expo-client, push-templates, isPushEnabled, push-channel, dispatcher fan-out) + integration BR-254; **Divergenze doc** = nessuna. Segnala lo smoke push DIFFERITO a fine arco.

- [ ] **Step 8: Watch CI**

Run: `gh pr checks --watch`
Expected: tutte verdi (unit + integration con Postgres reale + lint + commitlint + cdk-synth).

---

## Self-review (post-stesura)

**Spec coverage:**
- Fan-out push+email indipendente (BR-250) → Task 6. ✓
- Gating `push.*` (BR-226 default true) → Task 4 + Task 5. ✓
- Token load sotto admin ctx (scheduler tx / route own-ctx) → Task 5 (`AdminRunner`) + Task 6 (`run`) + Task 7. ✓
- BR-254 ticket-time deactivation + `app_installed` flip → Task 5 + Task 8. ✓
- Template push + data routing → Task 3. ✓
- Client Expo (`expo-server-sdk`, chunking) → Task 1. ✓
- `DispatchResult` back-compat (email-driven, push additivo) → Task 5 (types) + Task 6. ✓
- Dep/migration/deploy/EXPO_ACCESS_TOKEN → Task 1 + Task 9. ✓
- Smoke differito → annotato (Task 9 Step 7). ✓

**Type consistency:** `preferenceKeyForEvent` ritorna `NotificationEventPrefKey` (Task 2), consumato da `isEmailEnabled` (subset di `EmailEnabledKey`) e `isPushEnabled` (Task 4). `AdminRunner`/`PushTxLike` coerenti tra push-channel (Task 5) e dispatcher (Task 6). `PushDispatchResult` definito una volta (Task 5) e referenziato in dispatcher. ✓

**Placeholder scan:** nessun TBD/TODO; ogni step ha codice o comando concreto. ✓
