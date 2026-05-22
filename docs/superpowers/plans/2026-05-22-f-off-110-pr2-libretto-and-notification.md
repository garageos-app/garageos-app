# F-OFF-110 PR-2 — Libretto Upload + Cedente Notification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete F-OFF-110 by capturing an optional libretto document (S3 presigned upload) during the officina-mediated transfer wizard and emailing the previous owner when the transfer commits.

**Architecture:** A new presigned-PUT endpoint (co-located in the transfer route file) lets the browser upload the libretto to S3 during a new optional wizard step; the resulting key is passed back in the transfer body, validated server-side with `headObject` before the transaction, and stored on `VehicleTransfer.documentUrl`. On commit, the route resolves the cedente and dispatches a best-effort email via the existing H1 `lib/notifications` dispatcher with a new `ownership.transferred` event. Zero migrations, zero CDK/IAM changes.

**Tech Stack:** Fastify + TypeScript + Prisma + Zod (API), `@aws-sdk/client-s3` + `s3-request-presigner` (S3), AWS SES via the H1 notifications module, React + Vite + react-hook-form + TanStack Query (web), Vitest + `aws-sdk-client-mock` (tests).

**Spec:** `docs/superpowers/specs/2026-05-22-f-off-110-pr2-libretto-and-notification-design.md`

**Estimated size:** ~1000–1150 LOC. Mid-execution checkpoint (`feedback_mid_execution_loc_checkpoint`): soft-warn 1000, stop-and-ask 1200. The controller checks cumulative `git diff --stat` after each task.

**Task dependency order:** 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10. Task 2 depends on Task 1's template; Task 6 depends on Task 3's resolver; Task 8 depends on Task 7's hook. Each task ends green and committed.

---

## Task 1: Ownership-transferred email template

**Files:**
- Create: `packages/api/src/lib/notifications/templates/ownership-transferred.ts`
- Test: `packages/api/tests/unit/lib/notifications/templates/ownership-transferred.test.ts`

Pure render functions, mirroring `templates/intervention-cancelled.ts`. No deep link (BR-045: the cedente loses access to the vehicle).

- [ ] **Step 1: Write the failing test**

Create `packages/api/tests/unit/lib/notifications/templates/ownership-transferred.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import type { CustomerForNotification } from '../../../../../src/lib/notifications/types.js';
import {
  OWNERSHIP_TRANSFERRED_SUBJECT,
  renderOwnershipTransferredHtml,
  renderOwnershipTransferredText,
} from '../../../../../src/lib/notifications/templates/ownership-transferred.js';

const individual: CustomerForNotification = {
  id: 'c-1',
  email: 'mario@test.it',
  firstName: 'Mario',
  lastName: 'Rossi',
  isBusiness: false,
  businessName: null,
  notificationPreferences: {},
  status: 'active',
};

const business: CustomerForNotification = {
  ...individual,
  id: 'c-2',
  isBusiness: true,
  businessName: 'Autotrasporti Rossi SRL',
};

const baseInput = {
  recipient: individual,
  vehicle: { id: 'veh-1', plate: 'AB123CD' },
  tenant: { id: 't-1', businessName: 'Officina Bianchi' },
  transferReason: 'purchase' as const,
  transferredAt: '2026-05-22T10:30:00.000Z',
};

describe('ownership-transferred template', () => {
  it('subject is the fixed Italian string', () => {
    expect(OWNERSHIP_TRANSFERRED_SUBJECT).toBe(
      'La proprietà del tuo veicolo è stata trasferita',
    );
  });

  it('html greets the individual by first name and shows plate, officina, date, reason', () => {
    const html = renderOwnershipTransferredHtml(baseInput);
    expect(html).toContain('Ciao Mario,');
    expect(html).toContain('AB123CD');
    expect(html).toContain('Officina Bianchi');
    expect(html).toContain('22/05/2026');
    expect(html).toContain('Vendita');
    // BR-045 disclosure
    expect(html).toContain('non avrai più accesso allo storico');
  });

  it('html greets a business recipient by business name', () => {
    const html = renderOwnershipTransferredHtml({ ...baseInput, recipient: business });
    expect(html).toContain('Ciao Autotrasporti Rossi SRL,');
  });

  it('localizes every reason', () => {
    const reasons = [
      ['purchase', 'Vendita'],
      ['inheritance', 'Eredità'],
      ['company_assignment', 'Assegnazione aziendale'],
      ['other', 'Altro'],
    ] as const;
    for (const [reason, label] of reasons) {
      expect(renderOwnershipTransferredText({ ...baseInput, transferReason: reason })).toContain(
        label,
      );
    }
  });

  it('escapes HTML in interpolated values', () => {
    const html = renderOwnershipTransferredHtml({
      ...baseInput,
      tenant: { id: 't-1', businessName: '<script>x</script>' },
    });
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('does not contain an app deep link', () => {
    const html = renderOwnershipTransferredHtml(baseInput);
    expect(html).not.toContain('app.garageos');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/api vitest run tests/unit/lib/notifications/templates/ownership-transferred.test.ts`
Expected: FAIL — cannot resolve `templates/ownership-transferred.js`.

- [ ] **Step 3: Write the template**

Create `packages/api/src/lib/notifications/templates/ownership-transferred.ts`:

```ts
import type { CustomerForNotification, TenantForEmail, VehicleForEmail } from '../types.js';

export const OWNERSHIP_TRANSFERRED_SUBJECT = 'La proprietà del tuo veicolo è stata trasferita';

type TransferReason = 'purchase' | 'inheritance' | 'company_assignment' | 'other';

interface OwnershipTransferredTemplateInput {
  recipient: CustomerForNotification;
  vehicle: VehicleForEmail;
  tenant: TenantForEmail;
  transferReason: TransferReason;
  transferredAt: string; // ISO 8601
}

const REASON_LABELS: Record<TransferReason, string> = {
  purchase: 'Vendita',
  inheritance: 'Eredità',
  company_assignment: 'Assegnazione aziendale',
  other: 'Altro',
};

function getRecipientDisplayName(c: CustomerForNotification): string {
  if (c.isBusiness && c.businessName) return c.businessName;
  return c.firstName ?? 'Cliente';
}

// Format an ISO timestamp to DD/MM/YYYY. Manual formatting (not
// toLocaleDateString) keeps the output deterministic across runtimes.
function formatItDate(iso: string): string {
  const d = new Date(iso);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

export function renderOwnershipTransferredHtml(input: OwnershipTransferredTemplateInput): string {
  const name = getRecipientDisplayName(input.recipient);
  const date = formatItDate(input.transferredAt);
  const reason = REASON_LABELS[input.transferReason];
  return `<!DOCTYPE html>
<html lang="it"><body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 16px;">
<h1>Ciao ${escapeHtml(name)},</h1>
<p>Ti informiamo che la proprietà del veicolo con targa <strong>${escapeHtml(input.vehicle.plate)}</strong> è stata trasferita in data <strong>${escapeHtml(date)}</strong> dall'officina <strong>${escapeHtml(input.tenant.businessName)}</strong>.</p>
<p><strong>Motivo del trasferimento:</strong> ${escapeHtml(reason)}</p>
<p style="color: #666; font-size: 12px; margin-top: 32px;">Da questo momento non avrai più accesso allo storico interventi di questo veicolo (BR-045). Ricevi questa email perché risultavi proprietario di un veicolo registrato presso un'officina GarageOS.</p>
</body></html>`;
}

export function renderOwnershipTransferredText(input: OwnershipTransferredTemplateInput): string {
  const name = getRecipientDisplayName(input.recipient);
  const date = formatItDate(input.transferredAt);
  const reason = REASON_LABELS[input.transferReason];
  return `Ciao ${name},

Ti informiamo che la proprietà del veicolo con targa ${input.vehicle.plate} è stata trasferita in data ${date} dall'officina ${input.tenant.businessName}.

Motivo del trasferimento: ${reason}

---
Da questo momento non avrai più accesso allo storico interventi di questo veicolo (BR-045).
Ricevi questa email perché risultavi proprietario di un veicolo registrato presso un'officina GarageOS.`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
```

Note: `VehicleForEmail` is introduced in Task 2's `types.ts` edit. This file will not typecheck standalone until Task 2 lands — that is expected; Task 1 and Task 2 are committed in sequence and the branch is green after Task 2. Run only the Vitest file in Step 4 (Vitest transpiles per-file and resolves the type import lazily); the repo-wide `pnpm -r typecheck` is run at the end of Task 2.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @garageos/api vitest run tests/unit/lib/notifications/templates/ownership-transferred.test.ts`
Expected: PASS — 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/lib/notifications/templates/ownership-transferred.ts packages/api/tests/unit/lib/notifications/templates/ownership-transferred.test.ts
git commit -m "feat(api): add ownership-transferred email template"
```

---

## Task 2: Wire the ownership.transferred notification event

**Files:**
- Modify: `packages/api/src/lib/notifications/types.ts`
- Modify: `packages/api/src/lib/notification-preferences.ts`
- Modify: `packages/api/src/lib/notifications/dispatcher.ts`
- Test: `packages/api/tests/unit/lib/notifications/dispatcher.test.ts` (extend)

These three source files must change together — adding the event variant makes the dispatcher's two exhaustive switches non-exhaustive, and adding the `EmailEnabledKey` makes `DEFAULT_NOTIFICATION_PREFERENCES.email` indexing fail typecheck until the key is present. One atomic task.

- [ ] **Step 1: Write the failing test**

Append to `packages/api/tests/unit/lib/notifications/dispatcher.test.ts` a new `describe` block. Follow the existing file's harness for building the `DispatchInput` and stubbing `sendEmail` (read the file first — it already mocks `email-channel.js`). Representative cases:

```ts
describe('dispatchNotification — ownership.transferred', () => {
  const recipient = {
    id: 'c-cedente',
    email: 'cedente@test.it',
    firstName: 'Luca',
    lastName: 'Verdi',
    isBusiness: false,
    businessName: null,
    notificationPreferences: {},
    status: 'active' as const,
  };
  const event = {
    type: 'ownership.transferred' as const,
    vehicle: { id: 'veh-1', plate: 'AB123CD' },
    tenant: { id: 't-1', businessName: 'Officina Bianchi' },
    transferReason: 'purchase' as const,
    transferredAt: '2026-05-22T10:30:00.000Z',
  };

  it('sends the email when the ownership_transfer preference is on (default)', async () => {
    const result = await dispatchNotification({ event, recipient, logger: fakeLogger });
    expect(result.sent).toBe(true);
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        toAddress: 'cedente@test.it',
        subject: 'La proprietà del tuo veicolo è stata trasferita',
      }),
    );
  });

  it('skips when the customer disabled ownership_transfer emails', async () => {
    const optedOut = {
      ...recipient,
      notificationPreferences: { email: { ownership_transfer: false } },
    };
    const result = await dispatchNotification({ event, recipient: optedOut, logger: fakeLogger });
    expect(result).toEqual({ sent: false, skipped: 'pref-off' });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});
```

(Use the same `sendEmail` mock handle, `fakeLogger`, and imports already defined at the top of `dispatcher.test.ts`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/api vitest run tests/unit/lib/notifications/dispatcher.test.ts`
Expected: FAIL — `ownership.transferred` is not assignable to `NotificationEvent`.

- [ ] **Step 3: Add the event type and preference key**

In `packages/api/src/lib/notifications/types.ts`, add the `VehicleForEmail` interface near `TenantForEmail`:

```ts
export interface VehicleForEmail {
  id: string;
  plate: string;
}
```

Add the new variant to the `NotificationEvent` union (after the `deadline.reminder` variant):

```ts
  | {
      type: 'ownership.transferred';
      vehicle: VehicleForEmail;
      tenant: TenantForEmail;
      transferReason: 'purchase' | 'inheritance' | 'company_assignment' | 'other';
      transferredAt: string; // ISO 8601
    };
```

Add `'ownership_transfer'` to the `EmailEnabledKey` union:

```ts
export type EmailEnabledKey =
  | 'intervention_updates'
  | 'deadline_reminder'
  | 'transfer_invitation'
  | 'dispute_response'
  | 'ownership_transfer';
```

In `packages/api/src/lib/notification-preferences.ts`, add `ownership_transfer: true` to both the `email` and `push` blocks of `DEFAULT_NOTIFICATION_PREFERENCES` (default-on — losing ownership is a significant transactional notification):

```ts
export const DEFAULT_NOTIFICATION_PREFERENCES = {
  email: {
    intervention_updates: true,
    deadline_reminder: true,
    transfer_invitation: true,
    dispute_response: true,
    ownership_transfer: true,
    marketing: false,
  },
  push: {
    intervention_updates: true,
    deadline_reminder: true,
    transfer_invitation: true,
    dispute_response: true,
    ownership_transfer: true,
  },
} as const;
```

- [ ] **Step 4: Wire the dispatcher**

In `packages/api/src/lib/notifications/dispatcher.ts`:

Add the template import alongside the others:

```ts
import {
  OWNERSHIP_TRANSFERRED_SUBJECT,
  renderOwnershipTransferredHtml,
  renderOwnershipTransferredText,
} from './templates/ownership-transferred.js';
```

Add a case to `preferenceKeyForEvent`:

```ts
    case 'ownership.transferred':
      return 'ownership_transfer';
```

Add a case to the render `switch (event.type)`:

```ts
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
```

- [ ] **Step 5: Run tests + typecheck to verify green**

Run: `pnpm --filter @garageos/api vitest run tests/unit/lib/notifications/`
Expected: PASS — all notification unit tests, including the new ones. If `preferences.test.ts` asserts the full default-preferences object shape, add `ownership_transfer: true` to its expectation.

Run: `pnpm -r typecheck`
Expected: PASS — no errors (this also confirms Task 1's template now resolves `VehicleForEmail`).

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/lib/notifications/types.ts packages/api/src/lib/notification-preferences.ts packages/api/src/lib/notifications/dispatcher.ts packages/api/tests/unit/lib/notifications/dispatcher.test.ts packages/api/tests/unit/lib/notifications/preferences.test.ts
git commit -m "feat(api): wire ownership.transferred notification event"
```

(Include `preferences.test.ts` in the `git add` only if Step 5 required editing it.)

---

## Task 3: resolveCustomerForNotification helper

**Files:**
- Modify: `packages/api/src/lib/notifications/recipient-resolver.ts`
- Test: `packages/api/tests/unit/lib/notifications/recipient-resolver.test.ts` (extend)

`resolveCurrentOwner` resolves by `vehicleId`; the cedente must be resolved by `customerId` (after the transfer the *current* owner is the cessionario). Add a sibling keyed by `customerId` with the same deleted/anonymized skips.

- [ ] **Step 1: Write the failing test**

Append to `packages/api/tests/unit/lib/notifications/recipient-resolver.test.ts`:

```ts
import { resolveCustomerForNotification } from '../../../../src/lib/notifications/recipient-resolver.js';

interface CustomerFindUnique {
  customer: { findUnique: ReturnType<typeof vi.fn> };
}
function makeCustomerTx(stub: ReturnType<typeof vi.fn>): CustomerFindUnique {
  return { customer: { findUnique: stub } };
}

describe('resolveCustomerForNotification', () => {
  const activeCustomer = {
    id: 'cust-1',
    email: 'luca@test.it',
    firstName: 'Luca',
    lastName: 'Verdi',
    isBusiness: false,
    businessName: null,
    notificationPreferences: {},
    status: 'active',
  };

  it('returns the customer when found and active', async () => {
    const stub = vi.fn().mockResolvedValue(activeCustomer);
    const result = await resolveCustomerForNotification(makeCustomerTx(stub) as never, 'cust-1');
    expect(result).not.toBeNull();
    expect(result!.email).toBe('luca@test.it');
    expect(stub).toHaveBeenCalledWith({
      where: { id: 'cust-1' },
      select: expect.any(Object),
    });
  });

  it('returns null when the customer is missing', async () => {
    const stub = vi.fn().mockResolvedValue(null);
    expect(await resolveCustomerForNotification(makeCustomerTx(stub) as never, 'ghost')).toBeNull();
  });

  it('returns null when the customer status is deleted', async () => {
    const stub = vi.fn().mockResolvedValue({ ...activeCustomer, status: 'deleted' });
    expect(await resolveCustomerForNotification(makeCustomerTx(stub) as never, 'cust-1')).toBeNull();
  });

  it('returns null when the email is a deleted-hash placeholder (BR-158)', async () => {
    const stub = vi.fn().mockResolvedValue({
      ...activeCustomer,
      email: 'deleted-deadbeef@garageos.it',
    });
    expect(await resolveCustomerForNotification(makeCustomerTx(stub) as never, 'cust-1')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/api vitest run tests/unit/lib/notifications/recipient-resolver.test.ts`
Expected: FAIL — `resolveCustomerForNotification` is not exported.

- [ ] **Step 3: Implement the resolver**

In `packages/api/src/lib/notifications/recipient-resolver.ts`, widen the tx type and add the function. Change the `PrismaTxLike` line to also allow `customer`:

```ts
type PrismaTxLike = Pick<PrismaClient, 'vehicleOwnership'>;
type CustomerTxLike = Pick<PrismaClient, 'customer'>;
```

Append:

```ts
// Resolves a customer by id into the notification-recipient shape.
// Sibling of resolveCurrentOwner for callers that already hold a
// customerId (e.g. the cedente of an ownership transfer, who is no
// longer the vehicle's current owner). Same skips: deleted status
// and BR-158 anonymized email.
export async function resolveCustomerForNotification(
  tx: CustomerTxLike,
  customerId: string,
): Promise<CustomerForNotification | null> {
  const customer = await tx.customer.findUnique({
    where: { id: customerId },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      isBusiness: true,
      businessName: true,
      notificationPreferences: true,
      status: true,
    },
  });
  if (!customer) return null;
  if (customer.status === 'deleted') return null;
  if (customer.email.startsWith('deleted-') && customer.email.endsWith('@garageos.it')) {
    return null;
  }
  return customer as CustomerForNotification;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @garageos/api vitest run tests/unit/lib/notifications/recipient-resolver.test.ts`
Expected: PASS — all resolver tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/lib/notifications/recipient-resolver.ts packages/api/tests/unit/lib/notifications/recipient-resolver.test.ts
git commit -m "feat(api): add resolveCustomerForNotification helper"
```

---

## Task 4: Libretto document presign endpoint

**Files:**
- Modify: `packages/api/src/routes/v1/vehicles-ownership-transfer.ts`
- Test: `packages/api/tests/unit/routes/v1/vehicles-ownership-transfer.test.ts` (create)

A new `POST /v1/vehicles/:id/ownership-transfer/document-upload-url` registered in the existing transfer route file. Returns a presigned PUT URL; creates no DB row.

- [ ] **Step 1: Write the failing test**

Create `packages/api/tests/unit/routes/v1/vehicles-ownership-transfer.test.ts`. Mirror the harness in `packages/api/tests/unit/routes/v1/attachments.test.ts` (Fastify app + mocked `withContext` + `aws-sdk-client-mock` + a `JwtVerifier` returning the officine pool with role `super_admin`). The mock tx needs a `vehicle.findFirst` returning a vehicle for the happy path and `null` for the 404 case.

```ts
import sensible from '@fastify/sensible';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as s3Module from '../../../../src/lib/s3.js';
import { _resetS3ClientForTests, S3UnavailableError } from '../../../../src/lib/s3.js';
import databasePlugin from '../../../../src/plugins/database.js';
import { registerErrorHandler } from '../../../../src/plugins/error-handler.js';
import type { JwtVerifier, VerifyResult } from '../../../../src/plugins/auth.js';
import { vehiclesOwnershipTransferRoutes } from '../../../../src/routes/v1/vehicles-ownership-transfer.js';

const s3Mock = mockClient(S3Client);

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const COGNITO_SUB = '66666666-6666-4666-8666-666666666666';
const VEHICLE_ID = '88888888-8888-4888-8888-888888888888';

interface MockTx {
  user: { findFirst: ReturnType<typeof vi.fn>; findFirstOrThrow: ReturnType<typeof vi.fn> };
  vehicle: { findFirst: ReturnType<typeof vi.fn>; findUniqueOrThrow: ReturnType<typeof vi.fn> };
}

function buildMockTx(overrides: Partial<MockTx> = {}): MockTx {
  return {
    user: {
      findFirst: vi.fn().mockResolvedValue({ id: 'user-db-id' }),
      findFirstOrThrow: vi.fn().mockResolvedValue({ id: 'user-db-id' }),
      ...overrides.user,
    },
    vehicle: {
      findFirst: vi.fn().mockResolvedValue({ id: VEHICLE_ID }),
      findUniqueOrThrow: vi.fn(),
      ...overrides.vehicle,
    },
  };
}

function buildVerifier(): JwtVerifier {
  return {
    verify: async (): Promise<VerifyResult> => ({
      pool: 'officine',
      payload: {
        sub: COGNITO_SUB,
        token_use: 'id',
        'custom:tenant_id': TENANT_ID,
        'custom:role': 'super_admin',
      },
    }),
  };
}

async function buildApp(overrides: Partial<MockTx> = {}): Promise<{
  app: FastifyInstance;
  mockTx: MockTx;
}> {
  const mockTx = buildMockTx(overrides);
  const withContext = vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(mockTx));
  const app = Fastify({ logger: false });
  await app.register(sensible);
  registerErrorHandler(app);
  await app.register(databasePlugin, {
    prisma: mockTx as never,
    withContext: withContext as never,
  });
  app.decorate('jwtVerifier', buildVerifier());
  await app.register(vehiclesOwnershipTransferRoutes);
  await app.ready();
  return { app, mockTx };
}

let app: FastifyInstance;
let mockTx: MockTx;

beforeEach(async () => {
  s3Mock.reset();
  _resetS3ClientForTests();
  s3Mock.on(PutObjectCommand).resolves({});
  ({ app, mockTx } = await buildApp());
});

afterEach(async () => {
  await app.close();
});

const URL = `/v1/vehicles/${VEHICLE_ID}/ownership-transfer/document-upload-url`;
const VALID_BODY = {
  fileName: 'libretto.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 1_048_576,
};

describe('POST /v1/vehicles/:id/ownership-transfer/document-upload-url', () => {
  it('returns 200 with a presigned PUT URL and a vehicle-transfers/ key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: URL,
      headers: { authorization: 'Bearer fake-token' },
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.uploadUrl).toContain('X-Amz-Signature=');
    expect(body.uploadMethod).toBe('PUT');
    expect(body.uploadHeaders).toEqual({ 'Content-Type': 'application/pdf' });
    expect(body.s3Key).toMatch(
      new RegExp(`^vehicle-transfers/${VEHICLE_ID}/[0-9a-f-]{36}\\.pdf$`),
    );
    expect(body.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('rejects a mime type outside the whitelist with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: URL,
      headers: { authorization: 'Bearer fake-token' },
      payload: { ...VALID_BODY, mimeType: 'image/webp' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects sizeBytes over 10 MB with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: URL,
      headers: { authorization: 'Bearer fake-token' },
      payload: { ...VALID_BODY, sizeBytes: 10 * 1024 * 1024 + 1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 vehicle.not_found when the vehicle is not visible to the tenant', async () => {
    ({ app, mockTx } = await buildApp({
      vehicle: { findFirst: vi.fn().mockResolvedValue(null), findUniqueOrThrow: vi.fn() },
    }));
    const res = await app.inject({
      method: 'POST',
      url: URL,
      headers: { authorization: 'Bearer fake-token' },
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('vehicle.not_found');
  });

  it('maps S3UnavailableError to 502 vehicle.transfer.document_s3_unavailable', async () => {
    const spy = vi
      .spyOn(s3Module, 'presignPutObject')
      .mockRejectedValueOnce(new S3UnavailableError('Simulated SDK failure'));
    const res = await app.inject({
      method: 'POST',
      url: URL,
      headers: { authorization: 'Bearer fake-token' },
      payload: VALID_BODY,
    });
    spy.mockRestore();
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe('vehicle.transfer.document_s3_unavailable');
  });

  it('derives the .jpg extension from image/jpeg', async () => {
    const res = await app.inject({
      method: 'POST',
      url: URL,
      headers: { authorization: 'Bearer fake-token' },
      payload: { fileName: 'libretto.jpg', mimeType: 'image/jpeg', sizeBytes: 2_000_000 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().s3Key).toMatch(/\.jpg$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/api vitest run tests/unit/routes/v1/vehicles-ownership-transfer.test.ts`
Expected: FAIL — route returns 404 from Fastify (endpoint not registered).

- [ ] **Step 3: Implement the presign endpoint**

In `packages/api/src/routes/v1/vehicles-ownership-transfer.ts`:

Add imports at the top:

```ts
import { randomUUID } from 'node:crypto';

import { env } from '../../config/env.js';
import { S3UnavailableError, presignPutObject } from '../../lib/s3.js';
```

Add module-level constants after `ParamsSchema`:

```ts
// F-OFF-110 PR-2 — libretto document upload. Single document, 10 MB cap,
// 4 formats (no webp — a libretto scan does not need it). Stored under
// the vehicle-transfers/ prefix on the shared attachments bucket.
const LIBRETTO_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'application/pdf',
  'image/heic',
] as const;
const LIBRETTO_MAX_SIZE_BYTES = 10 * 1024 * 1024;
const LIBRETTO_URL_EXPIRY_SECONDS = 900; // 15 min

const DocumentUrlBodySchema = z.object({
  fileName: z
    .string()
    .trim()
    .min(1)
    .max(255)
    // eslint-disable-next-line no-control-regex
    .refine((v) => !/[\x00-\x1F]/.test(v), 'control bytes not allowed'),
  mimeType: z.enum(LIBRETTO_MIME_TYPES),
  sizeBytes: z.number().int().positive().max(LIBRETTO_MAX_SIZE_BYTES),
});

function deriveLibrettoExtension(mimeType: (typeof LIBRETTO_MIME_TYPES)[number]): string {
  switch (mimeType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'application/pdf':
      return 'pdf';
    case 'image/heic':
      return 'heic';
  }
}
```

Register the route inside the `vehiclesOwnershipTransferRoutes` plugin (after the existing `app.post('/v1/vehicles/:id/ownership-transfer', ...)` block, before the closing `};`):

```ts
  app.post(
    '/v1/vehicles/:id/ownership-transfer/document-upload-url',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request, reply) => {
      const parsedParams = ParamsSchema.safeParse(request.params);
      if (!parsedParams.success) throw parsedParams.error;
      const parsedBody = DocumentUrlBodySchema.safeParse(request.body);
      if (!parsedBody.success) throw parsedBody.error;

      const role = request.userRole;
      if (role !== 'super_admin' && role !== 'mechanic') {
        throw businessError(
          'vehicle.transfer.role_denied',
          403,
          'Ruolo non autorizzato per il trasferimento.',
        );
      }

      const tenantId = request.tenantId!;
      const vehicleId = parsedParams.data.id;
      const body = parsedBody.data;

      // Tenant scoping: presign only for a vehicle the caller's tenant
      // created or certified (same predicate as performOwnershipTransfer
      // step 1). vehicles SELECT RLS is permissive, so this explicit
      // filter is the application-layer enforcement.
      const vehicle = await app.prisma.vehicle.findFirst({
        where: {
          id: vehicleId,
          OR: [{ certifiedByTenantId: tenantId }, { createdByTenantId: tenantId }],
        },
        select: { id: true },
      });
      if (!vehicle) {
        throw businessError('vehicle.not_found', 404, 'Veicolo non trovato.');
      }

      const documentId = randomUUID();
      const ext = deriveLibrettoExtension(body.mimeType);
      const s3Key = `vehicle-transfers/${vehicleId}/${documentId}.${ext}`;

      let uploadUrl: string;
      try {
        uploadUrl = await presignPutObject({
          bucket: env.S3_ATTACHMENTS_BUCKET,
          key: s3Key,
          contentType: body.mimeType,
          contentLength: body.sizeBytes,
          expiresInSeconds: LIBRETTO_URL_EXPIRY_SECONDS,
        });
      } catch (err) {
        if (err instanceof S3UnavailableError) {
          throw businessError(
            'vehicle.transfer.document_s3_unavailable',
            502,
            'Servizio storage temporaneamente non disponibile.',
          );
        }
        throw err;
      }

      const expiresAt = new Date(
        Date.now() + LIBRETTO_URL_EXPIRY_SECONDS * 1000,
      ).toISOString();

      return reply.code(200).send({
        uploadUrl,
        uploadMethod: 'PUT' as const,
        uploadHeaders: { 'Content-Type': body.mimeType },
        s3Key,
        expiresAt,
      });
    },
  );
```

- [ ] **Step 4: Run test + typecheck to verify green**

Run: `pnpm --filter @garageos/api vitest run tests/unit/routes/v1/vehicles-ownership-transfer.test.ts`
Expected: PASS — 6 tests green.

Run: `pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/v1/vehicles-ownership-transfer.ts packages/api/tests/unit/routes/v1/vehicles-ownership-transfer.test.ts
git commit -m "feat(api): add libretto document presign endpoint"
```

---

## Task 5: Persist the libretto key on the transfer

**Files:**
- Modify: `packages/api/src/lib/ownership-transfer.ts`
- Modify: `packages/api/src/routes/v1/vehicles-ownership-transfer.ts`
- Test: `packages/api/tests/unit/lib/ownership-transfer.test.ts` (extend)
- Test: `packages/api/tests/unit/routes/v1/vehicles-ownership-transfer.test.ts` (extend)

The transfer body gains an optional `documentS3Key`; the route validates its shape and existence (`headObject`) before the transaction; the lib stores it on `VehicleTransfer.documentUrl`.

- [ ] **Step 1: Write the failing lib test**

In `packages/api/tests/unit/lib/ownership-transfer.test.ts`, the FakePrisma `vehicleTransfer.create` mock already exists. Append a test that passes `documentS3Key` and asserts it reaches the create call:

```ts
  it('persists documentUrl on the transfer row when documentS3Key is provided', async () => {
    const key = 'vehicle-transfers/v1/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.pdf';
    await performOwnershipTransfer(env.tx as never, { ...baseInput, documentS3Key: key });
    expect(env.tx.vehicleTransfer.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ documentUrl: key }),
      }),
    );
  });

  it('sets documentUrl null when documentS3Key is absent', async () => {
    await performOwnershipTransfer(env.tx as never, baseInput);
    expect(env.tx.vehicleTransfer.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ documentUrl: null }),
      }),
    );
  });
```

Add `documentUrl?: string | null` to the `TransferCreateData` interface near the top of the file (so the mock's typed `data` parameter accepts it).

- [ ] **Step 2: Run lib test to verify it fails**

Run: `pnpm --filter @garageos/api vitest run tests/unit/lib/ownership-transfer.test.ts`
Expected: FAIL — `documentS3Key` is not a property of `OwnershipTransferInput`; `documentUrl` not present on the create call.

- [ ] **Step 3: Extend the lib**

In `packages/api/src/lib/ownership-transfer.ts`:

Add to `OwnershipTransferInput`:

```ts
  documentS3Key?: string | null;
```

In step 7, the `vehicleTransfer.create` data — add `documentUrl`:

```ts
  const transferRow = await tx.vehicleTransfer.create({
    data: {
      vehicleId: input.vehicleId,
      fromCustomerId: currentOwnership.customerId,
      toCustomerId,
      method: 'officina_mediated',
      status: 'completed',
      expiresAt: now,
      completedAt: now,
      documentUrl: input.documentS3Key ?? null,
    },
    select: { id: true, completedAt: true },
  });
```

- [ ] **Step 4: Run lib test to verify it passes**

Run: `pnpm --filter @garageos/api vitest run tests/unit/lib/ownership-transfer.test.ts`
Expected: PASS — all lib tests green, including the 2 new ones.

- [ ] **Step 5: Write the failing route test**

Append a `describe` block to `packages/api/tests/unit/routes/v1/vehicles-ownership-transfer.test.ts`. The transfer route needs a richer mock tx — extend `MockTx` / `buildMockTx` so it covers `user.findFirstOrThrow`, `vehicle.findFirst`, `vehicleOwnership`, `vehicleTransfer`, `customer`, `customerTenantRelation`, `accessLog`, `tenant` (the route delegates to `performOwnershipTransfer`, so reuse the FakePrisma shape from `tests/unit/lib/ownership-transfer.test.ts` — read that file and copy its `makeStub()` tx object into a helper here, or import the lib tests' approach). Then:

```ts
import { HeadObjectCommand } from '@aws-sdk/client-s3';
// ... s3Module already imported

describe('POST /v1/vehicles/:id/ownership-transfer — documentS3Key', () => {
  const TRANSFER_URL = `/v1/vehicles/${VEHICLE_ID}/ownership-transfer`;
  const validKey = `vehicle-transfers/${VEHICLE_ID}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.pdf`;
  const transferBody = {
    recipient: { kind: 'existing', customerId: '22222222-2222-4222-8222-222222222222' },
    reason: 'purchase',
  };

  it('rejects a documentS3Key that does not match the vehicle prefix with 422', async () => {
    const res = await app.inject({
      method: 'POST',
      url: TRANSFER_URL,
      headers: { authorization: 'Bearer fake-token' },
      payload: { ...transferBody, documentS3Key: 'vehicle-transfers/other-vehicle/x.pdf' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('vehicle.transfer.document_invalid');
  });

  it('rejects a documentS3Key whose S3 object does not exist with 422', async () => {
    const spy = vi
      .spyOn(s3Module, 'headObject')
      .mockRejectedValueOnce(new s3Module.S3ObjectNotFoundError('missing'));
    const res = await app.inject({
      method: 'POST',
      url: TRANSFER_URL,
      headers: { authorization: 'Bearer fake-token' },
      payload: { ...transferBody, documentS3Key: validKey },
    });
    spy.mockRestore();
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('vehicle.transfer.document_invalid');
  });

  it('rejects a documentS3Key whose object exceeds 10 MB with 422', async () => {
    const spy = vi
      .spyOn(s3Module, 'headObject')
      .mockResolvedValueOnce({ contentLength: 10 * 1024 * 1024 + 1, contentType: 'application/pdf' });
    const res = await app.inject({
      method: 'POST',
      url: TRANSFER_URL,
      headers: { authorization: 'Bearer fake-token' },
      payload: { ...transferBody, documentS3Key: validKey },
    });
    spy.mockRestore();
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('vehicle.transfer.document_invalid');
  });

  it('accepts a valid documentS3Key and completes the transfer (200)', async () => {
    const spy = vi
      .spyOn(s3Module, 'headObject')
      .mockResolvedValueOnce({ contentLength: 1_048_576, contentType: 'application/pdf' });
    const res = await app.inject({
      method: 'POST',
      url: TRANSFER_URL,
      headers: { authorization: 'Bearer fake-token' },
      payload: { ...transferBody, documentS3Key: validKey },
    });
    spy.mockRestore();
    expect(res.statusCode).toBe(200);
  });
});
```

Note: building a full transfer-route mock tx is the bulk of this step. The cleanest route is to lift `makeStub()` from `tests/unit/lib/ownership-transfer.test.ts` into a small shared test helper, or duplicate it in this file. Duplication of ~110 lines of FakePrisma is acceptable here (test scaffolding); a future cleanup may extract `tests/helpers/ownership-transfer-stub.ts`. The transfer-route handler also calls `app.prisma.vehicle.findUniqueOrThrow` for the final read — give `vehicle.findUniqueOrThrow` a mock returning `{ id, garageCode: null, plate: 'AB123CD', status: 'certified' }` (the `vehicleDetailSelect` shape; the test only asserts status code, so a minimal object is fine).

- [ ] **Step 6: Run route test to verify it fails**

Run: `pnpm --filter @garageos/api vitest run tests/unit/routes/v1/vehicles-ownership-transfer.test.ts`
Expected: FAIL — `documentS3Key` is ignored (no validation), the malformed-key case returns 200 instead of 422.

- [ ] **Step 7: Extend the transfer route**

In `packages/api/src/routes/v1/vehicles-ownership-transfer.ts`:

Add the `headObject` + `S3ObjectNotFoundError` imports (extend the existing `s3.js` import):

```ts
import { S3ObjectNotFoundError, S3UnavailableError, headObject, presignPutObject } from '../../lib/s3.js';
```

Add `documentS3Key` to `BodySchema` — inside the `.object({...})`, before the `.refine`:

```ts
    documentS3Key: z.string().trim().max(500).nullable().optional(),
```

Add a key-shape validator near the other module constants:

```ts
// Matches the suffix of a libretto key after the vehicle-transfers/<vehicleId>/
// prefix: a UUID + one of the 4 allowed extensions. Keeps a malicious client
// from passing an arbitrary or cross-vehicle S3 key into documentUrl.
const LIBRETTO_KEY_SUFFIX_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|pdf|heic)$/;

function isValidDocumentKey(key: string, vehicleId: string): boolean {
  const prefix = `vehicle-transfers/${vehicleId}/`;
  if (!key.startsWith(prefix)) return false;
  return LIBRETTO_KEY_SUFFIX_RE.test(key.slice(prefix.length));
}
```

In the `POST /v1/vehicles/:id/ownership-transfer` handler, after the role check and `const body = parsedBody.data;`, before `app.withContext`, add the document validation (S3 calls must run outside the Postgres transaction — `feedback_cognito_call_outside_postgres_tx`):

```ts
      // Validate the optional libretto document BEFORE opening the
      // transaction — headObject is an external S3 call.
      let validatedDocumentKey: string | null = null;
      if (body.documentS3Key) {
        if (!isValidDocumentKey(body.documentS3Key, vehicleId)) {
          throw businessError(
            'vehicle.transfer.document_invalid',
            422,
            'Documento del libretto non valido.',
          );
        }
        let head: { contentLength: number; contentType: string };
        try {
          head = await headObject(env.S3_ATTACHMENTS_BUCKET, body.documentS3Key);
        } catch (err) {
          if (err instanceof S3ObjectNotFoundError) {
            throw businessError(
              'vehicle.transfer.document_invalid',
              422,
              'Documento del libretto non trovato su S3.',
            );
          }
          if (err instanceof S3UnavailableError) {
            throw businessError(
              'vehicle.transfer.document_s3_unavailable',
              502,
              'Servizio storage temporaneamente non disponibile.',
            );
          }
          throw err;
        }
        if (
          head.contentLength > LIBRETTO_MAX_SIZE_BYTES ||
          !(LIBRETTO_MIME_TYPES as readonly string[]).includes(head.contentType)
        ) {
          throw businessError(
            'vehicle.transfer.document_invalid',
            422,
            'Documento del libretto non conforme (dimensione o formato).',
          );
        }
        validatedDocumentKey = body.documentS3Key;
      }
```

Pass it into `performOwnershipTransfer` — add to the input object:

```ts
        return performOwnershipTransfer(tx, {
          vehicleId,
          tenantId,
          actorUserId: actor.id,
          recipient: body.recipient,
          reason: body.reason,
          notes: body.notes ?? null,
          documentS3Key: validatedDocumentKey,
        });
```

- [ ] **Step 8: Run tests + typecheck to verify green**

Run: `pnpm --filter @garageos/api vitest run tests/unit/routes/v1/vehicles-ownership-transfer.test.ts tests/unit/lib/ownership-transfer.test.ts`
Expected: PASS — all tests green.

Run: `pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/api/src/lib/ownership-transfer.ts packages/api/src/routes/v1/vehicles-ownership-transfer.ts packages/api/tests/unit/lib/ownership-transfer.test.ts packages/api/tests/unit/routes/v1/vehicles-ownership-transfer.test.ts
git commit -m "feat(api): persist libretto document key on transfer"
```

---

## Task 6: Email the cedente on transfer completion

**Files:**
- Modify: `packages/api/src/lib/ownership-transfer.ts`
- Modify: `packages/api/src/routes/v1/vehicles-ownership-transfer.ts`
- Test: `packages/api/tests/unit/lib/ownership-transfer.test.ts` (extend)
- Test: `packages/api/tests/unit/routes/v1/vehicles-ownership-transfer.test.ts` (extend)

The lib resolves the cedente and surfaces the notification data in its result; the route dispatches a best-effort email after commit.

- [ ] **Step 1: Write the failing lib test**

The lib's FakePrisma stub in `tests/unit/lib/ownership-transfer.test.ts` must grow: the cedente resolve calls `tx.customer.findUnique` (which the stub already has, but it currently returns `StubCustomer = { id, email }`), and the lib fetches the tenant via `tx.tenant.findUniqueOrThrow`. Update the stub:

1. Extend `StubCustomer` with the notification fields:

```ts
interface StubCustomer {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  isBusiness: boolean;
  businessName: string | null;
  notificationPreferences: unknown;
  status: 'active' | 'pending_verification' | 'deleted';
}
```

2. Seed `c-cedente` and `c-recipient` in `beforeEach` with the full shape, e.g.:

```ts
env.state.customers.set('c-cedente', {
  id: 'c-cedente',
  email: 'cedente@example.com',
  firstName: 'Cedente',
  lastName: 'Test',
  isBusiness: false,
  businessName: null,
  notificationPreferences: {},
  status: 'active',
});
```

(Apply the same shape to `c-recipient`.)

3. Add a `tenants` map to `StubState` and a `tenant` group to the stub tx:

```ts
// in StubState:
tenants: Map<string, { id: string; businessName: string }>;
// in makeStub state init:
tenants: new Map(),
// in the tx object:
tenant: {
  findUniqueOrThrow: vi
    .fn()
    .mockImplementation(({ where }: { where: { id: string } }) => {
      const t = state.tenants.get(where.id);
      if (!t) return Promise.reject(new Error('P2025'));
      return Promise.resolve(t);
    }),
},
```

Seed `t1` in `beforeEach`: `env.state.tenants.set('t1', { id: 't1', businessName: 'Officina Test' });`

Then add tests:

```ts
  it('result carries the cedente as previousOwner and the vehicle plate + tenant', async () => {
    const result = await performOwnershipTransfer(env.tx as never, baseInput);
    expect(result.previousOwner).not.toBeNull();
    expect(result.previousOwner!.id).toBe('c-cedente');
    expect(result.vehiclePlate).toBe('AB123CD');
    expect(result.tenant).toEqual({ id: 't1', businessName: 'Officina Test' });
    expect(result.transferReason).toBe('purchase');
    expect(result.transferCompletedAt).toBeInstanceOf(Date);
  });

  it('previousOwner is null when the cedente is a deleted customer', async () => {
    env.state.customers.set('c-cedente', {
      id: 'c-cedente',
      email: 'cedente@example.com',
      firstName: 'Cedente',
      lastName: 'Test',
      isBusiness: false,
      businessName: null,
      notificationPreferences: {},
      status: 'deleted',
    });
    const result = await performOwnershipTransfer(env.tx as never, baseInput);
    expect(result.previousOwner).toBeNull();
  });
```

Also add `plate: 'AB123CD'` to the `StubVehicle` interface and the seeded `v1` vehicle (the lib's step 1 select now includes `plate`).

- [ ] **Step 2: Run lib test to verify it fails**

Run: `pnpm --filter @garageos/api vitest run tests/unit/lib/ownership-transfer.test.ts`
Expected: FAIL — `previousOwner` / `vehiclePlate` / `tenant` not on `OwnershipTransferResult`.

- [ ] **Step 3: Extend the lib**

In `packages/api/src/lib/ownership-transfer.ts`:

Add imports:

```ts
import { resolveCustomerForNotification } from './notifications/recipient-resolver.js';
import type { CustomerForNotification } from './notifications/types.js';
```

Extend `OwnershipTransferResult`:

```ts
export interface OwnershipTransferResult {
  vehicleId: string;
  ownership: { id: string; customerId: string; startedAt: Date };
  transfer: {
    id: string;
    status: 'completed';
    completedAt: Date;
    reason: TransferReason;
    notes: string | null;
  };
  previousOwner: CustomerForNotification | null;
  vehiclePlate: string;
  tenant: { id: string; businessName: string };
  transferReason: TransferReason;
  transferCompletedAt: Date;
}
```

In `performOwnershipTransfer`, step 1 — add `plate` to the vehicle select:

```ts
    select: { id: true, status: true, plate: true },
```

After step 2 (the `currentOwnership` null-check), resolve the cedente:

```ts
  // Resolve the cedente for the post-commit notification. Runs inside
  // the transaction so it is part of the consistent snapshot; the
  // dispatch itself happens after commit in the route handler.
  const previousOwner = await resolveCustomerForNotification(tx, currentOwnership.customerId);
```

Before the `return`, fetch the tenant:

```ts
  const tenant = await tx.tenant.findUniqueOrThrow({
    where: { id: input.tenantId },
    select: { id: true, businessName: true },
  });
```

Extend the returned object:

```ts
  return {
    vehicleId: input.vehicleId,
    ownership: newOwnership,
    transfer: {
      id: transferRow.id,
      status: 'completed' as const,
      completedAt: transferRow.completedAt!,
      reason: input.reason,
      notes: input.notes,
    },
    previousOwner,
    vehiclePlate: vehicle.plate,
    tenant,
    transferReason: input.reason,
    transferCompletedAt: transferRow.completedAt!,
  };
```

- [ ] **Step 4: Run lib test to verify it passes**

Run: `pnpm --filter @garageos/api vitest run tests/unit/lib/ownership-transfer.test.ts`
Expected: PASS — all lib tests green.

- [ ] **Step 5: Write the failing route test**

Append to `packages/api/tests/unit/routes/v1/vehicles-ownership-transfer.test.ts`. Mock the dispatcher module so the route's `dispatchNotification` import is a spy. At the top of the file add:

```ts
import * as dispatcherModule from '../../../../src/lib/notifications/dispatcher.js';
```

Then the describe block:

```ts
describe('POST /v1/vehicles/:id/ownership-transfer — cedente notification', () => {
  const TRANSFER_URL = `/v1/vehicles/${VEHICLE_ID}/ownership-transfer`;
  const transferBody = {
    recipient: { kind: 'existing', customerId: '22222222-2222-4222-8222-222222222222' },
    reason: 'purchase',
  };

  it('dispatches an ownership.transferred email when the cedente is resolvable', async () => {
    const spy = vi
      .spyOn(dispatcherModule, 'dispatchNotification')
      .mockResolvedValue({ sent: true });
    const res = await app.inject({
      method: 'POST',
      url: TRANSFER_URL,
      headers: { authorization: 'Bearer fake-token' },
      payload: transferBody,
    });
    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({ type: 'ownership.transferred' }),
      }),
    );
    spy.mockRestore();
  });

  it('does not dispatch when the cedente is not resolvable (previousOwner null)', async () => {
    // Force the FakePrisma cedente customer to status=deleted so the
    // lib resolves previousOwner=null.
    // (configure the mock tx's customer.findUnique to return a deleted row)
    const spy = vi
      .spyOn(dispatcherModule, 'dispatchNotification')
      .mockResolvedValue({ sent: false, skipped: 'no-recipient' });
    // ...build app with a deleted cedente customer...
    // assert spy not called
    spy.mockRestore();
  });
});
```

The exact wiring of the "deleted cedente" case depends on the route test's mock tx. Configure `customer.findUnique` for the cedente id to return a row with `status: 'deleted'` so `resolveCustomerForNotification` returns null and the route skips the dispatch. Assert `spy` was not called.

- [ ] **Step 6: Run route test to verify it fails**

Run: `pnpm --filter @garageos/api vitest run tests/unit/routes/v1/vehicles-ownership-transfer.test.ts`
Expected: FAIL — `dispatchNotification` is never called (route does not dispatch yet).

- [ ] **Step 7: Wire the dispatch in the route**

In `packages/api/src/routes/v1/vehicles-ownership-transfer.ts`:

Add the import:

```ts
import { dispatchNotification } from '../../lib/notifications/dispatcher.js';
```

In the `POST /v1/vehicles/:id/ownership-transfer` handler, after the `const vehicle = await app.prisma.vehicle.findUniqueOrThrow(...)` line and before `return reply.code(200).send(...)`:

```ts
      // Best-effort cedente notification. dispatchNotification never
      // throws (documented contract) — a notification failure never
      // affects the already-committed transfer.
      if (result.previousOwner) {
        await dispatchNotification({
          event: {
            type: 'ownership.transferred',
            vehicle: { id: vehicleId, plate: result.vehiclePlate },
            tenant: result.tenant,
            transferReason: result.transferReason,
            transferredAt: result.transferCompletedAt.toISOString(),
          },
          recipient: result.previousOwner,
          logger: request.log,
        });
      }
```

- [ ] **Step 8: Run tests + typecheck to verify green**

Run: `pnpm --filter @garageos/api vitest run tests/unit/routes/v1/vehicles-ownership-transfer.test.ts tests/unit/lib/ownership-transfer.test.ts`
Expected: PASS.

Run: `pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/api/src/lib/ownership-transfer.ts packages/api/src/routes/v1/vehicles-ownership-transfer.ts packages/api/tests/unit/lib/ownership-transfer.test.ts packages/api/tests/unit/routes/v1/vehicles-ownership-transfer.test.ts
git commit -m "feat(api): email cedente on ownership transfer"
```

---

## Task 7: useTransferDocumentUpload web hook

**Files:**
- Create: `packages/web/src/queries/transferDocumentUpload.ts`
- Test: `packages/web/src/queries/transferDocumentUpload.test.tsx`

A presign → S3-PUT hook (no confirm step). Exports the libretto validation helper + constants for the dialog to reuse.

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/queries/transferDocumentUpload.test.tsx`. Follow the harness in `packages/web/src/queries/attachmentUpload.test.tsx` (read it first — it wraps the hook in a `QueryClientProvider`, mocks `useApiFetch`, and stubs `XMLHttpRequest`). Representative cases:

```tsx
import { describe, expect, it } from 'vitest';
import {
  validateLibrettoFile,
  LIBRETTO_MAX_SIZE_BYTES,
} from './transferDocumentUpload';

describe('validateLibrettoFile', () => {
  it('accepts a valid PDF under 10 MB', () => {
    const file = new File(['x'], 'libretto.pdf', { type: 'application/pdf' });
    expect(validateLibrettoFile(file)).toBeNull();
  });

  it('rejects an unsupported mime type', () => {
    const file = new File(['x'], 'libretto.webp', { type: 'image/webp' });
    expect(validateLibrettoFile(file)).toEqual({
      code: 'mime_not_supported',
      received: 'image/webp',
    });
  });

  it('rejects a file over 10 MB', () => {
    const file = new File(['x'], 'big.pdf', { type: 'application/pdf' });
    Object.defineProperty(file, 'size', { value: LIBRETTO_MAX_SIZE_BYTES + 1 });
    expect(validateLibrettoFile(file)).toMatchObject({ code: 'size_exceeded' });
  });
});
```

Add a hook test that mounts `useTransferDocumentUpload`, mocks `useApiFetch` to return a presign response, stubs `XMLHttpRequest` to succeed, and asserts `upload(file)` resolves to `{ ok: true, s3Key }` and `state.phase === 'success'`; and a failure case where the presign `apiFetch` rejects with an `ApiError` and `upload` resolves to `{ ok: false, ... }`. Mirror the XHR stub from `attachmentUpload.test.tsx`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/web vitest run src/queries/transferDocumentUpload.test.tsx`
Expected: FAIL — cannot resolve `./transferDocumentUpload`.

- [ ] **Step 3: Implement the hook**

Create `packages/web/src/queries/transferDocumentUpload.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from 'react';

import { useApiFetch, ApiError } from '@/lib/api-client';

// F-OFF-110 PR-2 — libretto document upload (presign → S3 PUT).
// No confirm step: the libretto is not an Attachment row; the key is
// passed into the transfer body and stored on VehicleTransfer.documentUrl.

export const LIBRETTO_ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'application/pdf',
  'image/heic',
] as const;
export type LibrettoMimeType = (typeof LIBRETTO_ALLOWED_MIME_TYPES)[number];
export const LIBRETTO_MAX_SIZE_BYTES = 10 * 1024 * 1024;

export type LibrettoValidationError =
  | { code: 'mime_not_supported'; received: string }
  | { code: 'size_exceeded'; received: number; max: number };

export function validateLibrettoFile(file: File): LibrettoValidationError | null {
  if (!(LIBRETTO_ALLOWED_MIME_TYPES as readonly string[]).includes(file.type)) {
    return { code: 'mime_not_supported', received: file.type };
  }
  if (file.size > LIBRETTO_MAX_SIZE_BYTES) {
    return { code: 'size_exceeded', received: file.size, max: LIBRETTO_MAX_SIZE_BYTES };
  }
  return null;
}

interface DocumentUploadUrlResponse {
  uploadUrl: string;
  uploadMethod: 'PUT';
  uploadHeaders: Record<string, string>;
  s3Key: string;
  expiresAt: string;
}

export type TransferUploadState =
  | { phase: 'idle' }
  | { phase: 'requesting' }
  | { phase: 'uploading'; progress: number }
  | { phase: 'success'; s3Key: string; fileName: string }
  | { phase: 'error'; code: string; message: string };

export type TransferUploadResult =
  | { ok: true; s3Key: string }
  | { ok: false; code: string; message: string };

export interface UseTransferDocumentUploadResult {
  upload: (file: File) => Promise<TransferUploadResult>;
  state: TransferUploadState;
  reset: () => void;
}

export function useTransferDocumentUpload(vehicleId: string): UseTransferDocumentUploadResult {
  const apiFetch = useApiFetch();
  const [state, setState] = useState<TransferUploadState>({ phase: 'idle' });
  const xhrRef = useRef<XMLHttpRequest | null>(null);

  useEffect(() => {
    return () => {
      xhrRef.current?.abort();
    };
  }, []);

  const reset = useCallback(() => setState({ phase: 'idle' }), []);

  const upload = useCallback(
    async (file: File): Promise<TransferUploadResult> => {
      setState({ phase: 'requesting' });
      let presign: DocumentUploadUrlResponse;
      try {
        presign = await apiFetch<DocumentUploadUrlResponse>(
          `/v1/vehicles/${vehicleId}/ownership-transfer/document-upload-url`,
          {
            method: 'POST',
            body: JSON.stringify({
              fileName: file.name,
              mimeType: file.type,
              sizeBytes: file.size,
            }),
          },
        );
      } catch (e) {
        const err = toErrorResult(e);
        setState({ phase: 'error', code: err.code, message: err.message });
        return err;
      }

      setState({ phase: 'uploading', progress: 0 });
      try {
        await putToS3(
          presign,
          file,
          (progress) => setState({ phase: 'uploading', progress }),
          xhrRef,
        );
      } catch (e) {
        const err = toErrorResult(e);
        setState({ phase: 'error', code: err.code, message: err.message });
        return err;
      }

      setState({ phase: 'success', s3Key: presign.s3Key, fileName: file.name });
      return { ok: true, s3Key: presign.s3Key };
    },
    [apiFetch, vehicleId],
  );

  return { upload, state, reset };
}

// Direct S3 PUT via XHR (fetch cannot surface upload progress). The
// sibling useAttachmentUpload has an equivalent helper; kept local
// here to keep PR-2 self-contained (no cross-feature refactor).
function putToS3(
  presign: DocumentUploadUrlResponse,
  file: File,
  onProgress: (progress: number) => void,
  xhrRef: React.MutableRefObject<XMLHttpRequest | null>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    xhr.open(presign.uploadMethod, presign.uploadUrl);
    for (const [k, v] of Object.entries(presign.uploadHeaders)) {
      xhr.setRequestHeader(k, v);
    }
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      xhrRef.current = null;
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new XhrHttpError(xhr.status));
    };
    xhr.onerror = () => {
      xhrRef.current = null;
      reject(new XhrNetworkError());
    };
    xhr.onabort = () => {
      xhrRef.current = null;
      reject(new XhrAbortError());
    };
    xhr.send(file);
  });
}

class XhrHttpError extends Error {
  httpStatus: number;
  constructor(httpStatus: number) {
    super(`S3 PUT returned HTTP ${httpStatus}`);
    this.httpStatus = httpStatus;
  }
}
class XhrNetworkError extends Error {
  constructor() {
    super('S3 PUT network error');
  }
}
class XhrAbortError extends Error {
  constructor() {
    super('S3 PUT aborted');
  }
}

function toErrorResult(e: unknown): { ok: false; code: string; message: string } {
  if (e instanceof ApiError) {
    return { ok: false, code: e.code, message: e.message };
  }
  if (e instanceof XhrHttpError) {
    return { ok: false, code: 'xhr.http_error', message: `Upload fallito (HTTP ${e.httpStatus}).` };
  }
  if (e instanceof XhrNetworkError) {
    return { ok: false, code: 'xhr.network_error', message: "Errore di rete durante l'upload." };
  }
  if (e instanceof XhrAbortError) {
    return { ok: false, code: 'xhr.aborted', message: 'Upload interrotto.' };
  }
  return { ok: false, code: 'unknown', message: e instanceof Error ? e.message : 'Errore sconosciuto' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @garageos/web vitest run src/queries/transferDocumentUpload.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/queries/transferDocumentUpload.ts packages/web/src/queries/transferDocumentUpload.test.tsx
git commit -m "feat(web): add useTransferDocumentUpload hook"
```

---

## Task 8: Libretto upload step in the transfer wizard

**Files:**
- Modify: `packages/web/src/queries/ownershipTransfer.ts`
- Modify: `packages/web/src/components/OwnershipTransferDialog.tsx`
- Test: `packages/web/src/components/OwnershipTransferDialog.test.tsx` (create)

The wizard goes 3 → 4 steps: Cessionario → Motivo & note → **Documento** → Conferma. The PR-1 dialog has no component test; PR-2 creates one focused on the PR-2 surface (the existing steps 1–2 remain a pre-existing test-coverage gap, out of PR-2 scope).

- [ ] **Step 1: Extend the mutation payload**

In `packages/web/src/queries/ownershipTransfer.ts`, add a field to `OwnershipTransferPayload`:

```ts
export interface OwnershipTransferPayload {
  recipient: OwnershipTransferRecipient;
  reason: TransferReason;
  notes?: string | null;
  documentS3Key?: string | null;
}
```

No other change — `mutationFn` already serializes the whole payload.

- [ ] **Step 2: Write the failing component test**

Create `packages/web/src/components/OwnershipTransferDialog.test.tsx`. Follow an existing dialog test for the harness (e.g. `packages/web/src/components/DisputeResponseDialog.test.tsx` or `EditInterventionDialog.test.tsx`): wrap in `QueryClientProvider`, render the dialog `open`, use `userEvent` for all interactions (`feedback_radix_tabs_user_event_not_fire_event`).

Mock the three query hooks with `vi.mock`:
- `@/queries/customerSearch` — `useCustomerSearch` returns one result so step 1 can advance.
- `@/queries/ownershipTransfer` — `useOwnershipTransfer` returns a controllable `mutateAsync` spy.
- `@/queries/transferDocumentUpload` — partial mock: keep the real `validateLibrettoFile` + constants via `vi.importActual`, replace `useTransferDocumentUpload` with a fake whose `upload` resolves to `{ ok: true, s3Key: 'vehicle-transfers/veh-1/...pdf' }`.

Representative cases:

```tsx
it('navigates to the Documento step and allows skipping (no document)', async () => {
  // render, select recipient (step 1), pick reason (step 2), click Avanti → step 3
  // step 3 shows the libretto heading; click "Avanti" with no file → step 4
  // step 4 confirm summary shows "Nessun documento allegato"
});

it('rejects an unsupported file type with an inline error', async () => {
  // on step 3, upload a File with type image/gif
  // expect an inline error message; upload() must not have been called
});

it('uploads a valid libretto and includes documentS3Key in the submit payload', async () => {
  // on step 3, select a valid application/pdf File
  // fake upload resolves ok → the file name is shown
  // advance to step 4, click "Conferma trasferimento"
  // expect mutateAsync called with documentS3Key === the fake s3Key
});

it('confirm summary shows the file name when a document was uploaded', async () => {
  // after a successful upload, step 4 summary contains the file name
});
```

The dialog props: `open`, `onOpenChange`, `vehicleId`, `vehicleLabel`, `currentOwnerCustomerId` (see the `Props` interface). Drive the file input via its `data-testid="libretto-file-input"` with `userEvent.upload`.

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @garageos/web vitest run src/components/OwnershipTransferDialog.test.tsx`
Expected: FAIL — the Documento step does not exist; the dialog is still 3 steps.

- [ ] **Step 4: Implement the 4-step wizard**

In `packages/web/src/components/OwnershipTransferDialog.tsx`:

Update the header comment (`3-step` → `4-step`) and add imports:

```ts
import { useRef } from 'react';
import {
  useTransferDocumentUpload,
  validateLibrettoFile,
} from '@/queries/transferDocumentUpload';
```

(Merge `useRef` into the existing `import { useState } from 'react';` line → `import { useRef, useState } from 'react';`.)

Widen the step state and add document state inside the component:

```ts
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  // ...existing state...
  const [documentS3Key, setDocumentS3Key] = useState<string | null>(null);
  const [documentFileName, setDocumentFileName] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { upload, state: uploadState, reset: resetUpload } = useTransferDocumentUpload(vehicleId);
```

Extend `reset()`:

```ts
  function reset() {
    setStep(1);
    setSearch('');
    setShowNewForm(false);
    setRecipient(null);
    setReason('');
    setNotes('');
    setDocumentS3Key(null);
    setDocumentFileName(null);
    setUploadError(null);
    resetUpload();
    newForm.reset();
  }
```

Add the file-select and remove handlers:

```ts
  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file after Rimuovi
    if (!file) return;
    const validation = validateLibrettoFile(file);
    if (validation) {
      setUploadError(
        validation.code === 'mime_not_supported'
          ? 'Formato non supportato. Usa JPG, PNG, PDF o HEIC.'
          : 'File troppo grande. Dimensione massima 10 MB.',
      );
      return;
    }
    setUploadError(null);
    const result = await upload(file);
    if (result.ok) {
      setDocumentS3Key(result.s3Key);
      setDocumentFileName(file.name);
    } else {
      setUploadError(result.message);
    }
  }

  function handleRemoveDocument() {
    setDocumentS3Key(null);
    setDocumentFileName(null);
    setUploadError(null);
    resetUpload();
  }
```

Update the title to `Step {step}/4`.

Change step 2's "Avanti" button — it currently does `onClick={() => setStep(3)}`. It still goes to step 3, which is now the Documento step — no change needed (step 3 is Documento).

Insert the new Documento step block between the `step === 2` block and the `step === 3` block, and renumber the old confirm block from `step === 3` to `step === 4`:

```tsx
        {step === 3 && recipient && (
          <div className="space-y-4">
            <div>
              <Label>Libretto di circolazione (opzionale)</Label>
              <p className="text-sm text-muted-foreground">
                Carica una foto o scansione del libretto verificato. Puoi saltare questo
                passaggio.
              </p>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,application/pdf,image/heic"
              className="hidden"
              data-testid="libretto-file-input"
              onChange={handleFileSelected}
            />

            {!documentS3Key && (
              <Button
                type="button"
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadState.phase === 'requesting' || uploadState.phase === 'uploading'}
              >
                Scegli file
              </Button>
            )}

            {uploadState.phase === 'uploading' && (
              <div className="text-sm text-muted-foreground" role="status">
                Caricamento… {Math.round(uploadState.progress * 100)}%
              </div>
            )}

            {documentS3Key && documentFileName && (
              <div className="flex items-center justify-between rounded border p-2 text-sm">
                <span>{documentFileName}</span>
                <Button type="button" variant="ghost" size="sm" onClick={handleRemoveDocument}>
                  Rimuovi
                </Button>
              </div>
            )}

            {uploadError && (
              <p className="text-sm text-destructive" role="alert">
                {uploadError}
              </p>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={() => setStep(2)}>
                Indietro
              </Button>
              <Button
                onClick={() => setStep(4)}
                disabled={
                  uploadState.phase === 'requesting' || uploadState.phase === 'uploading'
                }
              >
                Avanti
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === 4 && recipient && reason && (
          <div className="space-y-4">
            <Alert variant="destructive">
              <AlertDescription>
                Confermando il trasferimento, il veicolo <strong>{vehicleLabel}</strong> passerà a{' '}
                <strong>{recipient.displayName}</strong> in modo permanente. Verifica di aver
                controllato il libretto di circolazione. Questa azione non può essere annullata.
              </AlertDescription>
            </Alert>
            <div className="text-sm space-y-1">
              <div>
                <strong>Cessionario:</strong> {recipient.displayName} ({recipient.email})
              </div>
              <div>
                <strong>Motivo:</strong> {REASON_OPTIONS.find((o) => o.value === reason)?.label}
              </div>
              {notes && (
                <div>
                  <strong>Note:</strong> {notes}
                </div>
              )}
              <div>
                <strong>Libretto:</strong>{' '}
                {documentFileName ?? 'Nessun documento allegato'}
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setStep(3)} disabled={mutation.isPending}>
                Indietro
              </Button>
              <Button
                variant="destructive"
                onClick={handleConfirm}
                disabled={mutation.isPending}
              >
                {mutation.isPending ? 'Trasferimento in corso…' : 'Conferma trasferimento'}
              </Button>
            </DialogFooter>
          </div>
        )}
```

(The `step === 4` block is the old `step === 3` block verbatim, with the step number changed, the "Indietro" target changed to `setStep(3)`, and the libretto summary line added.)

Update `handleConfirm` to include the document key:

```ts
      await mutation.mutateAsync({
        recipient: recipient.data,
        reason,
        notes: notes.trim() || null,
        documentS3Key,
      });
```

- [ ] **Step 5: Run test + typecheck to verify green**

Run: `pnpm --filter @garageos/web vitest run src/components/OwnershipTransferDialog.test.tsx`
Expected: PASS.

Run: `pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/queries/ownershipTransfer.ts packages/web/src/components/OwnershipTransferDialog.tsx packages/web/src/components/OwnershipTransferDialog.test.tsx
git commit -m "feat(web): add libretto upload step to transfer wizard"
```

---

## Task 9: API integration tests

**Files:**
- Modify: `packages/api/tests/integration/vehicles-ownership-transfer.test.ts` (extend)

Integration tests hit real Postgres (Testcontainers). The external S3 boundary is stubbed via `vi.spyOn(s3Module, 'headObject')` so the tests are deterministic and need no test bucket — they verify the route's transaction behaviour and DB state, not S3 itself.

- [ ] **Step 1: Write the integration tests**

Read `packages/api/tests/integration/vehicles-ownership-transfer.test.ts` first to reuse its seed helpers, auth-token helper, and `remoteAddress` convention. Add new `describe` blocks, each with a unique `remoteAddress` (`feedback_integration_test_rate_limit_isolation`). Cases:

1. **Presign happy path** — `POST .../document-upload-url` with a valid body → 200, `s3Key` starts with `vehicle-transfers/<vehicleId>/`, `uploadUrl` contains `X-Amz-Signature=`.
2. **Presign 404** — same call for a vehicle owned by a different tenant → 404 `vehicle.not_found`.
3. **Transfer with a valid documentS3Key** — `vi.spyOn(s3Module, 'headObject').mockResolvedValue({ contentLength: 1_048_576, contentType: 'application/pdf' })`; POST the transfer with `documentS3Key = vehicle-transfers/<vehicleId>/<uuid>.pdf` → 200; then query the `vehicle_transfers` row and assert `documentUrl` equals the key.
4. **Transfer with a non-existent S3 object** — `vi.spyOn(s3Module, 'headObject').mockRejectedValue(new s3Module.S3ObjectNotFoundError('x'))` → 422 `vehicle.transfer.document_invalid`.
5. **Transfer with a cross-vehicle key** — `documentS3Key` for a different vehicle id → 422 `vehicle.transfer.document_invalid` (the regex guard rejects it before `headObject`).
6. **Regression** — a transfer with no `documentS3Key` → 200, `vehicle_transfers.documentUrl` is `NULL` (PR-1 behaviour intact).

`afterEach`: `vi.restoreAllMocks()` so a spy from one test does not leak.

For the cedente email — if the existing integration suite has a pattern for asserting notification dispatch (it may stub `sendEmail` or assert via logs), mirror it; otherwise do not add an email-delivery assertion here (the dispatch wiring is already covered by the Task 6 route unit test, and `dispatchNotification` is best-effort).

- [ ] **Step 2: Typecheck**

Run: `pnpm -r typecheck`
Expected: PASS.

Do **not** run the integration suite locally — it requires Docker/Testcontainers and is gated by CI (`feedback_skip_local_integration_tests`). CI validates this task.

- [ ] **Step 3: Commit**

```bash
git add packages/api/tests/integration/vehicles-ownership-transfer.test.ts
git commit -m "test(api): integration tests for F-OFF-110 PR-2"
```

---

## Task 10: Documentation updates

**Files:**
- Modify: `docs/APPENDICE_A_API.md`
- Modify: `docs/APPENDICE_F_BUSINESS_LOGIC.md`
- Modify: `docs/APPENDICE_G_ERROR_CODES.md`
- Modify: `docs/GarageOS-Specifiche.md`

- [ ] **Step 1: APPENDICE_A — API**

In the F-OFF-110 section (`§2.3bis POST /vehicles/:id/ownership-transfer`):
- Add the optional `documentS3Key` field to the request-body description (max 500 chars, must be a key returned by the document-upload-url endpoint).
- Add `vehicle.transfer.document_invalid` (422) to the endpoint's error table.
- Add a new sub-section `§2.3ter POST /vehicles/:id/ownership-transfer/document-upload-url` documenting: auth (officine pool, `super_admin`/`mechanic`), request body `{ fileName, mimeType, sizeBytes }` (mime ∈ JPG/PNG/PDF/HEIC, size ≤ 10 MB), response `{ uploadUrl, uploadMethod, uploadHeaders, s3Key, expiresAt }`, and the error rows 400 / 404 `vehicle.not_found` / 502 `vehicle.transfer.document_s3_unavailable`.

- [ ] **Step 2: APPENDICE_F — Business logic**

In BR-049, add a paragraph noting that the officina-mediated transfer optionally captures the verified libretto (stored as an S3 key on `VehicleTransfer.documentUrl`) and sends a best-effort email notification to the cedente on completion.

In BR-226 (notification preferences), add the `ownership_transfer` email key (default `true`) to the documented preference set and bump the BR-226 version note.

- [ ] **Step 3: APPENDICE_G — Error codes**

Register the new codes in the `vehicle.transfer.*` family:
- `vehicle.transfer.document_invalid` — 422 — the supplied libretto key is malformed, points to a missing object, or the object violates the size/format limits.
- `vehicle.transfer.document_s3_unavailable` — 502 — the S3 service was unavailable while signing or verifying the libretto upload.

- [ ] **Step 4: GarageOS-Specifiche.md**

In the F-OFF-110 feature row, remove the trailing qualifier "PR-1 senza upload documento/email notification (PR-2 follow-up)" — PR-2 now ships both.

- [ ] **Step 5: Format check + commit**

Run: `pnpm exec prettier --check "docs/APPENDICE_A_API.md" "docs/APPENDICE_F_BUSINESS_LOGIC.md" "docs/APPENDICE_G_ERROR_CODES.md" "docs/GarageOS-Specifiche.md"`
If it reports issues, run the same command with `--write`.

> Do **not** modify `docs/APPENDICE_E_TESTING.md` — editing it trips the pre-commit `secretlint` block on pre-existing PG connection strings (tech debt #1). The BR-049 test-matrix entry stays deferred to the cleanup bundle.

```bash
git add docs/APPENDICE_A_API.md docs/APPENDICE_F_BUSINESS_LOGIC.md docs/APPENDICE_G_ERROR_CODES.md docs/GarageOS-Specifiche.md
git commit -m "docs: F-OFF-110 PR-2 API, error code, BR updates"
```

---

## Final verification

After Task 10:

- [ ] Run `pnpm -r typecheck` — expected PASS (the husky pre-push hook enforces this).
- [ ] Run `git diff --stat main` — confirm cumulative LOC; if over 1200, halt and report to the controller per `feedback_mid_execution_loc_checkpoint`.
- [ ] Open the PR with the CLAUDE.md template; link F-OFF-110 and BR-049/BR-045/BR-226; list the BR coverage; note SES sandbox as a known operational limitation for cedente-email delivery in production.
- [ ] CI runs lint, full unit, integration (Testcontainers), and cdk-synth. Fix-forward on any red.

## Self-review notes (plan author)

- **Spec coverage:** presign endpoint → Task 4; `documentS3Key` validation + persistence → Task 5; cedente email (event/template/preference/resolver/dispatch) → Tasks 1/2/3/6; web hook → Task 7; web wizard step → Task 8; integration tests → Task 9; docs → Task 10. All spec sections map to a task.
- **Spec correction:** the spec said "extend `OwnershipTransferDialog.test.tsx`" — that file does not exist (PR-1 deferred web component tests). Task 8 *creates* it, scoped to the PR-2 surface.
- **Spec correction:** the spec error table listed a `503` for S3-unavailable; the codebase convention (`attachments.ts`) is `502`. The plan uses `502 vehicle.transfer.document_s3_unavailable`.
- **Type consistency:** `VehicleForEmail` (Task 2) is used by the template (Task 1) and the event (Task 2); `OwnershipTransferResult` fields added in Task 6 (`previousOwner`, `vehiclePlate`, `tenant`, `transferReason`, `transferCompletedAt`) are consumed by the Task 6 route dispatch; `documentS3Key` flows route → `OwnershipTransferInput` → `documentUrl` consistently across Tasks 5–6.
