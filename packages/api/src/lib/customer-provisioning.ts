import { Prisma, type PrismaClient } from '@garageos/database';

import { customerSelfSelect, type CustomerSelfRow } from './customer-shared.js';
import { DEFAULT_NOTIFICATION_PREFERENCES } from './notification-preferences.js';

// Outcome of an idempotent customer-provisioning attempt.
//   'created'        — no row existed; a fresh Customer was inserted (BR-220).
//   'promoted'       — a shadow row (cognito_sub IS NULL AND app_installed=false)
//                      was claimed (BR-221).
//   'already_active' — a row already exists AND is active (cognito_sub set OR
//                      app_installed=true). No write is performed; the caller
//                      decides what it means: the password signup endpoint
//                      rejects with 409, the Cognito Google-federation trigger
//                      (PR 2) treats it as the account-merge case.
export type ProvisionOutcome = 'created' | 'promoted' | 'already_active';

export interface ProvisionCustomerInput {
  // Caller normalises (trimmed + lowercased) before calling.
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
}

export interface ProvisionCustomerOptions {
  // Stored in audit_logs.metadata.ip and audit_logs.ip_address. Signup passes
  // request.ip; the federation trigger may omit it.
  ip?: string;
  // Extra key/values merged into audit_logs.metadata (e.g. { provider: 'google' }).
  auditMetadata?: Record<string, unknown>;
}

export interface ProvisionCustomerResult {
  customer: CustomerSelfRow;
  outcome: ProvisionOutcome;
}

// Idempotent find-or-create-or-promote for a Customer row, keyed on email.
//
// Extracted verbatim from the Phase-1 DB transaction of POST /v1/auth/signup so
// the same advisory-locked, BR-tested logic backs both the password signup
// endpoint and the Cognito Google-federation trigger. See
// docs/superpowers/specs/2026-06-20-mobile-google-signin-design.md.
//
// MUST run inside a transaction context opened by the caller via
// app.withContext({ role: 'admin' }, async (tx) => ...). role:'admin' is
// required so the customers _write RLS policy allows the PROMOTE/CREATE for a
// brand-new customer (no customer_tenant_relations row yet). The advisory lock
// is xact-scoped, so it only serialises while that transaction is open.
//
// See APPENDICE_F BR-220/221/224/226.
export async function provisionCustomer(
  tx: PrismaClient,
  input: ProvisionCustomerInput,
  opts: ProvisionCustomerOptions = {},
): Promise<ProvisionCustomerResult> {
  // BR-220 race serialisation: xact-scoped advisory lock keyed on
  // `signup:<email>`. The SAME key is used by every caller so a password
  // signup and a Google federation for the same email serialise against each
  // other. `::text` cast works around Prisma 7 + @prisma/adapter-pg being
  // unable to deserialise a `void` column
  // (feedback_pg_void_return_prisma_adapter).
  await tx.$queryRawUnsafe<unknown[]>(
    `SELECT pg_advisory_xact_lock(hashtext($1))::text`,
    `signup:${input.email}`,
  );

  const existing = await tx.customer.findUnique({
    where: { email: input.email },
    select: { ...customerSelfSelect, cognitoSub: true, appInstalled: true },
  });

  // BR-224: a row is a promotable shadow iff cognito_sub IS NULL AND
  // app_installed = false. Anything else that already exists is "active".
  if (existing && (existing.cognitoSub !== null || existing.appInstalled === true)) {
    return {
      customer: {
        id: existing.id,
        email: existing.email,
        firstName: existing.firstName,
        lastName: existing.lastName,
        phone: existing.phone,
        status: existing.status,
        createdAt: existing.createdAt,
      },
      outcome: 'already_active',
    };
  }

  if (existing) {
    // PROMOTE — shadow customer becomes claimed (BR-221).
    const row = await tx.customer.update({
      where: { id: existing.id },
      data: {
        firstName: input.firstName,
        lastName: input.lastName,
        ...(input.phone ? { phone: input.phone } : {}),
        appInstalled: true,
        // BR-226: apply defaults on promote too — shadow rows carry `{}`.
        notificationPreferences: DEFAULT_NOTIFICATION_PREFERENCES,
      },
      select: customerSelfSelect,
    });
    await writeSignupAudit(tx, row.id, true, opts);
    return { customer: row, outcome: 'promoted' };
  }

  // CREATE — brand-new customer (BR-220).
  let row: CustomerSelfRow;
  try {
    row = await tx.customer.create({
      data: {
        email: input.email,
        firstName: input.firstName,
        lastName: input.lastName,
        ...(input.phone ? { phone: input.phone } : {}),
        status: 'active',
        appInstalled: true,
        notificationPreferences: DEFAULT_NOTIFICATION_PREFERENCES,
      },
      select: customerSelfSelect,
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      // Lost a create race (parallel tx committed first, or a hashtext
      // collision let an unrelated email through the lock). Re-fetch and
      // report the now-existing row as already_active — externally identical
      // to the pre-refactor 409 path in the signup route.
      const raced = await tx.customer.findUnique({
        where: { email: input.email },
        select: customerSelfSelect,
      });
      if (raced) {
        return { customer: raced, outcome: 'already_active' };
      }
    }
    throw err;
  }
  await writeSignupAudit(tx, row.id, false, opts);
  return { customer: row, outcome: 'created' };
}

async function writeSignupAudit(
  tx: PrismaClient,
  customerId: string,
  promoted: boolean,
  opts: ProvisionCustomerOptions,
): Promise<void> {
  await tx.auditLog.create({
    data: {
      tenantId: null,
      actorType: 'customer',
      actorId: customerId,
      action: 'customer_signup',
      entityType: 'customer',
      entityId: customerId,
      metadata: {
        promoted,
        ...(opts.ip ? { ip: opts.ip } : {}),
        ...(opts.auditMetadata ?? {}),
      },
      ipAddress: opts.ip ?? null,
    },
  });
}
