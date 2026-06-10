import type { FastifyBaseLogger } from 'fastify';

import type { PrismaClient } from '@garageos/database';

// Minimal structural subset of FastifyInstance consumed by the sweep — kept
// local (not imported from the deadlines scheduler) so the transfers module
// has no dependency on the deadlines module. Mirrors the AppLike rationale in
// lib/deadlines/scheduler-invocation.ts.
export interface AppLike {
  withContext: <T>(
    ctx: { tenantId?: string; customerId?: string; role?: 'admin' | 'user' },
    fn: (tx: PrismaClient) => Promise<T>,
  ) => Promise<T>;
  log: FastifyBaseLogger;
}

export interface TransferExpiryResult {
  sweptCount: number;
}

// processTransferExpiry — the daily housekeeping sweep (F-CLI-401 PR3).
//
// Flips every VehicleTransfer still in pending_recipient or
// pending_seller_confirmation past its expiresAt to status='expired'
// (BR-043 timeout: the vehicle stays with the seller). pending_validation
// (F-CLI-404 / BR-044) is intentionally excluded — its timeout means the
// opposite (no response => approved).
//
// The sweep touches ONLY vehicle_transfers: leaving pending_* drops the row
// out of the uq_transfer_vehicle_active predicate, freeing the BR-047 slot.
// vehicle_ownerships is untouched (the vehicle stays with the seller).
//
// Cross-tenant under role:'admin' (the EventBridge invocation carries no JWT;
// an empty ctx would silently deny the RLS write — see
// feedback_withcontext_empty_blocks_rls_writes). Idempotent: the status IN
// (pending_*) predicate makes a re-run a no-op (count 0). Never swallows a DB
// error — it propagates so the Lambda returns non-2xx and EventBridge retries.
export async function processTransferExpiry(input: {
  app: AppLike;
}): Promise<TransferExpiryResult> {
  const { app } = input;
  return app.withContext({ role: 'admin' }, async (tx) => {
    const now = new Date();
    const result = await tx.vehicleTransfer.updateMany({
      where: {
        status: { in: ['pending_recipient', 'pending_seller_confirmation'] },
        expiresAt: { lt: now },
      },
      data: { status: 'expired' },
    });
    app.log.info({ transferExpiry: { sweptCount: result.count } });
    // TODO(F-CLI-notifications): notify both parties that the transfer expired
    // (ownership_transfer push/email) once the notifications arc lands.
    return { sweptCount: result.count };
  });
}
