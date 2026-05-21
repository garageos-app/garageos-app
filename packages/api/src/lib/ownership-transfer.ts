// Officina-mediated vehicle ownership transfer (BR-049, F-OFF-110).
//
// Single-step atomic swap executed within a Prisma transaction with
// withContext({ role: 'admin' }). Closes the current vehicle_ownership,
// opens a new one for the recipient, writes a VehicleTransfer audit row
// with status='completed' / method='officina_mediated', and writes an
// AccessLog row.
//
// Pre-conditions (callers MUST ensure tenant scoping BEFORE calling):
//   - vehicle.tenantId === actor tenant (checked at route via findFirst)
//   - actorUserId is the DB user.id (NOT cognitoSub) — route resolves
//     this via tenant-context (cognitoSub + tenantId → user.id).
//
// Errors are surfaced via businessError() codes — see
// docs/APPENDICE_G_ERROR_CODES.md vehicle.transfer.* family.
//
// Lock order (memory feedback_code_review_lock_graph_analysis):
//   vehicles → vehicle_ownerships → vehicle_transfers → customers
//   → customer_tenant_relations
//
// Spec: docs/superpowers/specs/2026-05-21-f-off-110-officina-mediated-transfer-design.md

import { Prisma } from '@garageos/database';
import type { PrismaClient } from '@garageos/database';

import { businessError } from './business-error.js';

export type TransferReason = 'purchase' | 'inheritance' | 'company_assignment' | 'other';

export type RecipientInput =
  | { kind: 'existing'; customerId: string }
  | {
      kind: 'new';
      firstName: string;
      lastName: string;
      email: string;
      phone?: string | null;
      codiceFiscale?: string | null;
      isBusiness?: boolean;
      businessName?: string | null;
      vatNumber?: string | null;
    };

export interface OwnershipTransferInput {
  vehicleId: string;
  tenantId: string;
  actorUserId: string;
  recipient: RecipientInput;
  reason: TransferReason;
  notes: string | null;
}

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
}

type TxClient = Prisma.TransactionClient | PrismaClient;

async function resolveRecipient(
  tx: TxClient,
  tenantId: string,
  recipient: RecipientInput,
): Promise<{ toCustomerId: string }> {
  if (recipient.kind === 'existing') {
    const existing = await tx.customer.findUnique({
      where: { id: recipient.customerId },
      select: { id: true },
    });
    if (!existing) {
      throw businessError('vehicle.transfer.recipient_not_found', 422, 'Cessionario non trovato.');
    }
    await tx.customerTenantRelation.upsert({
      where: { tenantId_customerId: { tenantId, customerId: existing.id } },
      update: {},
      create: { tenantId, customerId: existing.id, interventionCount: 0 },
      select: { id: true },
    });
    return { toCustomerId: existing.id };
  }

  const found = await tx.customer.findFirst({
    where: { email: recipient.email },
    select: { id: true },
  });
  if (found) {
    await tx.customerTenantRelation.upsert({
      where: { tenantId_customerId: { tenantId, customerId: found.id } },
      update: {},
      create: { tenantId, customerId: found.id, interventionCount: 0 },
      select: { id: true },
    });
    return { toCustomerId: found.id };
  }

  try {
    const created = await tx.customer.create({
      data: {
        firstName: recipient.firstName,
        lastName: recipient.lastName,
        email: recipient.email,
        phone: recipient.phone ?? null,
        codiceFiscale: recipient.codiceFiscale ?? null,
        isBusiness: recipient.isBusiness ?? false,
        businessName: recipient.businessName ?? null,
        vatNumber: recipient.vatNumber ?? null,
      },
      select: { id: true },
    });
    await tx.customerTenantRelation.upsert({
      where: { tenantId_customerId: { tenantId, customerId: created.id } },
      update: {},
      create: { tenantId, customerId: created.id, interventionCount: 0 },
      select: { id: true },
    });
    return { toCustomerId: created.id };
  } catch (err: unknown) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const refetched = await tx.customer.findFirst({
        where: { email: recipient.email },
        select: { id: true },
      });
      if (refetched) {
        await tx.customerTenantRelation.upsert({
          where: { tenantId_customerId: { tenantId, customerId: refetched.id } },
          update: {},
          create: { tenantId, customerId: refetched.id, interventionCount: 0 },
          select: { id: true },
        });
        return { toCustomerId: refetched.id };
      }
    }
    throw err;
  }
}

export async function performOwnershipTransfer(
  tx: TxClient,
  input: OwnershipTransferInput,
): Promise<OwnershipTransferResult> {
  // Step 1: verify vehicle status (RLS-scoped via withContext at caller)
  const vehicle = await tx.vehicle.findFirst({
    where: { id: input.vehicleId, tenantId: input.tenantId },
    select: { id: true, status: true },
  });
  if (!vehicle) {
    throw businessError('vehicle.not_found', 404, 'Veicolo non trovato.');
  }
  if (vehicle.status === 'pending') {
    throw businessError(
      'vehicle.transfer.pending_not_transferable',
      422,
      'Veicolo non certificato non trasferibile (BR-046).',
    );
  }
  if (vehicle.status === 'archived') {
    throw businessError('vehicle.transfer.archived', 422, 'Veicolo archiviato non trasferibile.');
  }

  // Step 2: current active ownership
  const currentOwnership = await tx.vehicleOwnership.findFirst({
    where: { vehicleId: input.vehicleId, endedAt: null },
    select: { id: true, customerId: true },
  });
  if (!currentOwnership) {
    throw businessError(
      'vehicle.transfer.no_active_ownership',
      422,
      'Veicolo senza proprietario attivo.',
    );
  }

  // Step 3: no active transfer (BR-047 defensive check; DB unique enforces too)
  const activeTransfer = await tx.vehicleTransfer.findFirst({
    where: {
      vehicleId: input.vehicleId,
      status: { in: ['pending_recipient', 'pending_seller_confirmation', 'pending_validation'] },
    },
    select: { id: true },
  });
  if (activeTransfer) {
    throw businessError(
      'vehicle.transfer.active_transfer_exists',
      409,
      'Trasferimento già in corso per questo veicolo (BR-047).',
    );
  }

  // Step 4: resolve recipient (existing or new)
  const { toCustomerId } = await resolveRecipient(tx, input.tenantId, input.recipient);
  if (toCustomerId === currentOwnership.customerId) {
    throw businessError(
      'vehicle.transfer.same_owner',
      409,
      'Il cessionario coincide con il proprietario attuale.',
    );
  }

  // Step 5: close current ownership
  await tx.vehicleOwnership.update({
    where: { id: currentOwnership.id },
    data: {
      endedAt: new Date(),
      transferReason: input.reason,
      transferNotes: input.notes,
    },
  });

  // Step 6: open new ownership
  const newOwnership = await tx.vehicleOwnership.create({
    data: {
      vehicleId: input.vehicleId,
      customerId: toCustomerId,
      startedAt: new Date(),
      transferReason: input.reason,
      transferNotes: input.notes,
    },
    select: { id: true, customerId: true, startedAt: true },
  });

  // Step 7: audit transfer row
  const now = new Date();
  const transferRow = await tx.vehicleTransfer.create({
    data: {
      vehicleId: input.vehicleId,
      fromCustomerId: currentOwnership.customerId,
      toCustomerId,
      method: 'officina_mediated',
      status: 'completed',
      // expiresAt is NOT NULL in schema (designed for mobile BR-043 multi-step
      // flow). For officina_mediated single-step it's semantically unused —
      // set to now() so an `expiresAt > now()` filter never matches this row.
      expiresAt: now,
      completedAt: now,
    },
    select: { id: true, completedAt: true },
  });

  // Step 8: access log (correct schema — vehicleId+tenantId+userId required)
  await tx.accessLog.create({
    data: {
      vehicleId: input.vehicleId,
      tenantId: input.tenantId,
      userId: input.actorUserId,
      action: 'ownership_transfer',
    },
  });

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
  };
}
