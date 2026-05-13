import type { FastifyBaseLogger } from 'fastify';

import type { PrismaClient } from '@garageos/database';

// Local mirror of the Prisma AccessLogAction enum values. The
// @garageos/database barrel does not re-export generated enum types
// (tech-debt ledger: "subpath exports @garageos/database"); inlining
// the literal union keeps this PR scoped to the api package. Keep in
// sync with packages/database/prisma/schema.prisma enum AccessLogAction.
export type AccessLogAction = 'view' | 'create' | 'update' | 'search_match' | 'cancel' | 'respond';

// BR-154: 30-minute dedup window. Implementation strategy: SELECT the
// most recent log for (vehicle_id, user_id) since now - 30min; insert
// only if none exists. The access_logs table has a trigger
// (prevent_audit_modification — migration 20260424100000:180-183) that
// rejects UPDATE and DELETE, so we cannot bump an existing row's
// timestamp. Skipping the INSERT is the only valid path.
//
// The helper deliberately swallows insert errors and forwards them to
// `log.warn`: failing to record an access row must NEVER break the
// user-visible read endpoint. Loss of a dedup-skip entry is
// observability debt, not a correctness bug.

const DEDUP_WINDOW_MS = 30 * 60 * 1000;

export interface RecordVehicleAccessArgs {
  tx: PrismaClient;
  vehicleId: string;
  tenantId: string;
  userId: string;
  locationId?: string;
  action: AccessLogAction;
  ipAddress?: string;
  log?: FastifyBaseLogger;
}

export async function recordVehicleAccess(args: RecordVehicleAccessArgs): Promise<void> {
  const { tx, vehicleId, tenantId, userId, locationId, action, ipAddress, log } = args;
  const cutoff = new Date(Date.now() - DEDUP_WINDOW_MS);

  try {
    const recent = await tx.accessLog.findFirst({
      where: {
        vehicleId,
        userId,
        createdAt: { gte: cutoff },
      },
      select: { id: true },
    });
    if (recent) return;

    await tx.accessLog.create({
      data: {
        vehicleId,
        tenantId,
        userId,
        ...(locationId ? { locationId } : {}),
        action,
        ...(ipAddress ? { ipAddress } : {}),
      },
    });
  } catch (err) {
    log?.warn({ err, vehicleId, userId, action }, 'access-log: write failed');
  }
}

export interface RecordVehiclesBatchArgs {
  tx: PrismaClient;
  vehicleIds: string[];
  tenantId: string;
  userId: string;
  locationId?: string;
  action: AccessLogAction;
  ipAddress?: string;
  log?: FastifyBaseLogger;
}

// Bulk variant of recordVehicleAccess: 1 findMany (dedup) + 1 createMany.
// Replaces the per-row Promise.all(page.map(v => recordVehicleAccess({tx, ...})))
// pattern, which serialises 2N queries on the single Prisma $transaction
// connection (Prisma docs: tx is bound to one DB conn) — the cause of the
// ~10s tail on /v1/vehicles/search?customer= for high-N customers (PR #95).
// Errors are swallowed into log.warn for the same BR-154 rationale as the
// single-row helper: audit loss must not break the user-visible read.
export async function recordVehiclesBatch(args: RecordVehiclesBatchArgs): Promise<void> {
  const { tx, vehicleIds, tenantId, userId, locationId, action, ipAddress, log } = args;
  if (vehicleIds.length === 0) return;
  const cutoff = new Date(Date.now() - DEDUP_WINDOW_MS);

  try {
    const recent = await tx.accessLog.findMany({
      where: {
        vehicleId: { in: vehicleIds },
        userId,
        createdAt: { gte: cutoff },
      },
      select: { vehicleId: true },
    });
    const dedupSet = new Set(recent.map((r) => r.vehicleId));
    const toInsert = vehicleIds
      .filter((id) => !dedupSet.has(id))
      .map((vehicleId) => ({
        vehicleId,
        tenantId,
        userId,
        ...(locationId ? { locationId } : {}),
        action,
        ...(ipAddress ? { ipAddress } : {}),
      }));
    if (toInsert.length === 0) return;
    await tx.accessLog.createMany({ data: toInsert });
  } catch (err) {
    log?.warn({ err, vehicleIds, userId, action }, 'access-log: batch write failed');
  }
}
