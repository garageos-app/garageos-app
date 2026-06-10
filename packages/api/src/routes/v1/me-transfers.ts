import { Prisma } from '@garageos/database';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { businessError } from '../../lib/business-error.js';
import { serializeTransfer, TRANSFER_SELECT } from '../../lib/dtos/transfer.js';
import { generateTransferCode } from '../../lib/transfer-code.js';
import { confirmTransferSwap } from '../../lib/transfer-swap.js';
import { clientiContext } from '../../middleware/clienti-context.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireClientiPool } from '../../middleware/require-clienti-pool.js';

// /v1/me/transfers* — customer-app surface for seller-initiated vehicle
// ownership transfer (F-CLI-401, parte 402). PR1 = avvio + lettura: the
// ownership does NOT move here (BR-043 step 1). Accept/confirm/reject and
// the atomic swap land in PR2.
//
// Security: vehicle_transfers RLS is USING(true), so visibility is enforced
// entirely app-layer — every query filters fromCustomerId = customerId
// (the #154 lesson). Reads/writes run under role:'user' since vehicles,
// vehicle_ownerships and vehicle_transfers are all USING(true).

const TRANSFER_VALIDITY_DAYS = 7;
const CODE_RETRY_LIMIT = 5;
const ACTIVE_TRANSFER_STATUSES = [
  'pending_recipient',
  'pending_seller_confirmation',
  'pending_validation',
] as const;

const createBodySchema = z
  .object({
    vehicleId: z.uuid(),
    // PR1 only accepts physical_code; email_invitation is deferred until
    // the email channel is unblocked. Any other value → 400 ZodError.
    method: z.literal('physical_code'),
  })
  .strict();

const idParamSchema = z.object({ id: z.uuid() });
const codeParamSchema = z.object({ code: z.string().min(1) });

const meTransfersRoutes: FastifyPluginAsync = async (app) => {
  // POST /v1/me/transfers — F-CLI-401. Seller initiates a physical_code
  // transfer. Creates the row in pending_recipient; vehicle stays put.
  app.post(
    '/v1/me/transfers',
    { preHandler: [requireAuth, requireClientiPool, clientiContext] },
    async (request, reply) => {
      const { vehicleId } = createBodySchema.parse(request.body);
      const customerId = request.customerId!;

      return app.withContext({ customerId, role: 'user' }, async (tx) => {
        const vehicle = await tx.vehicle.findFirst({
          where: { id: vehicleId },
          select: {
            id: true,
            status: true,
            plate: true,
            make: true,
            model: true,
            ownerships: { where: { endedAt: null }, select: { id: true, customerId: true } },
          },
        });
        if (!vehicle) {
          throw businessError('transfer.creation.vehicle_not_found', 404, 'Veicolo non trovato.');
        }

        // BR-040: only the active owner may initiate.
        const active = vehicle.ownerships[0] ?? null;
        if (!active || active.customerId !== customerId) {
          throw businessError(
            'transfer.creation.not_current_owner',
            403,
            'Non sei il proprietario attuale del veicolo.',
          );
        }

        // BR-046: archived vehicles are not transferable (generic multi-flow 409).
        if (vehicle.status === 'archived') {
          throw businessError(
            'vehicle.archived',
            409,
            'Veicolo archiviato: operazione non disponibile.',
          );
        }

        // BR-046: pending (and any other non-certified) vehicles are not
        // transferable.
        if (vehicle.status !== 'certified') {
          throw businessError(
            'transfer.creation.vehicle_not_certified',
            422,
            'Veicolo non certificato: non puo essere trasferito.',
          );
        }

        // BR-047: at most one active transfer per vehicle.
        const existing = await tx.vehicleTransfer.findFirst({
          where: { vehicleId, status: { in: [...ACTIVE_TRANSFER_STATUSES] } },
          select: { id: true },
        });
        if (existing) {
          throw businessError(
            'transfer.creation.already_pending',
            409,
            'Esiste gia un trasferimento attivo per questo veicolo.',
          );
        }

        const expiresAt = new Date(Date.now() + TRANSFER_VALIDITY_DAYS * 24 * 60 * 60 * 1000);
        let lastErr: unknown;
        for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt++) {
          try {
            const row = await tx.vehicleTransfer.create({
              data: {
                vehicleId,
                fromCustomerId: customerId,
                toCustomerId: null,
                transferCode: generateTransferCode(),
                invitedEmail: null,
                method: 'initiated_by_seller',
                status: 'pending_recipient',
                expiresAt,
              },
              select: TRANSFER_SELECT,
            });
            reply.code(201);
            return serializeTransfer(row);
          } catch (err) {
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
              const target = String(err.meta?.target ?? '');
              // Concurrent initiation lost the BR-047 partial-unique race
              // (uq_transfer_vehicle_active): the vehicle already has an active
              // transfer. Do NOT retry — surface the same 409 as the pre-check.
              if (target.includes('uq_transfer_vehicle_active')) {
                throw businessError(
                  'transfer.creation.already_pending',
                  409,
                  'Esiste gia un trasferimento attivo per questo veicolo.',
                );
              }
              // transfer_code collision — retry with a fresh code.
              if (target.includes('transfer_code')) {
                lastErr = err;
                continue;
              }
            }
            throw err;
          }
        }
        throw lastErr; // exhausted retries on code collision (practically impossible)
      });
    },
  );

  // GET /v1/me/transfers — F-CLI-401/402. Transfers the caller initiated.
  // No pagination: a customer holds very few (YAGNI).
  app.get(
    '/v1/me/transfers',
    { preHandler: [requireAuth, requireClientiPool, clientiContext] },
    async (request) => {
      const customerId = request.customerId!;
      return app.withContext({ customerId, role: 'user' }, async (tx) => {
        const rows = await tx.vehicleTransfer.findMany({
          where: { fromCustomerId: customerId },
          orderBy: { createdAt: 'desc' },
          select: TRANSFER_SELECT,
        });
        return { data: rows.map(serializeTransfer) };
      });
    },
  );

  // GET /v1/me/transfers/:id — F-CLI-402. Detail of a transfer the caller
  // initiated. App-layer filter on fromCustomerId; out-of-perimeter id → 404
  // (does not reveal existence, mirrors me.vehicle.not_found).
  app.get(
    '/v1/me/transfers/:id',
    { preHandler: [requireAuth, requireClientiPool, clientiContext] },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const customerId = request.customerId!;
      return app.withContext({ customerId, role: 'user' }, async (tx) => {
        const row = await tx.vehicleTransfer.findFirst({
          where: { id, fromCustomerId: customerId },
          select: TRANSFER_SELECT,
        });
        if (!row) {
          throw businessError('transfer.not_found', 404, 'Trasferimento non trovato.');
        }
        return { transfer: serializeTransfer(row) };
      });
    },
  );

  // POST /v1/me/transfers/:code/accept — F-CLI-402/403. The recipient
  // accepts by entering the physical code. Sets toCustomerId = caller and
  // advances to pending_seller_confirmation; ownership does NOT move yet
  // (BR-043 step 2). Resets expiresAt so the seller's confirmation window
  // (BR-043: 7gg dall'accettazione) starts now. No request body.
  app.post(
    '/v1/me/transfers/:code/accept',
    { preHandler: [requireAuth, requireClientiPool, clientiContext] },
    async (request) => {
      const { code } = codeParamSchema.parse(request.params);
      const customerId = request.customerId!;

      return app.withContext({ customerId, role: 'user' }, async (tx) => {
        const row = await tx.vehicleTransfer.findFirst({
          where: { transferCode: code },
          select: { id: true, fromCustomerId: true, status: true, expiresAt: true },
        });
        if (!row) {
          throw businessError('transfer.not_found', 404, 'Trasferimento non trovato.');
        }
        if (row.fromCustomerId === customerId) {
          throw businessError(
            'transfer.acceptance.self_not_allowed',
            403,
            'Non puoi accettare un trasferimento avviato da te.',
          );
        }
        if (row.status === 'completed') {
          throw businessError(
            'transfer.acceptance.already_completed',
            409,
            'Trasferimento gia completato.',
          );
        }
        // A scheduler-flipped 'expired' status (PR3) precedes the timestamp
        // guard below, so surface it with the proper 410 rather than 422.
        if (row.status === 'expired' || row.expiresAt.getTime() < Date.now()) {
          throw businessError('transfer.acceptance.expired', 410, 'Trasferimento scaduto.');
        }
        if (row.status !== 'pending_recipient') {
          throw businessError(
            'transfer.acceptance.not_pending_recipient',
            422,
            'Trasferimento non accettabile in questo stato.',
          );
        }

        const newExpiry = new Date(Date.now() + TRANSFER_VALIDITY_DAYS * 24 * 60 * 60 * 1000);
        const cas = await tx.vehicleTransfer.updateMany({
          where: { id: row.id, status: 'pending_recipient' },
          data: {
            toCustomerId: customerId,
            status: 'pending_seller_confirmation',
            expiresAt: newExpiry,
          },
        });
        if (cas.count === 0) {
          // Lost the race to another acceptor / a reject.
          throw businessError(
            'transfer.acceptance.not_pending_recipient',
            422,
            'Trasferimento non accettabile in questo stato.',
          );
        }

        const updated = await tx.vehicleTransfer.findFirst({
          where: { id: row.id, toCustomerId: customerId },
          select: TRANSFER_SELECT,
        });
        // TODO(F-CLI-notifications): notify the seller that the recipient
        // accepted (ownership_transfer push/email), post-commit.
        return { transfer: serializeTransfer(updated!) };
      });
    },
  );

  // POST /v1/me/transfers/:id/confirm — F-CLI-403. The seller confirms after
  // the recipient accepted; this is where ownership actually moves (BR-043
  // step 4) via the atomic confirmTransferSwap. No request body.
  app.post(
    '/v1/me/transfers/:id/confirm',
    { preHandler: [requireAuth, requireClientiPool, clientiContext] },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const customerId = request.customerId!;

      return app.withContext({ customerId, role: 'user' }, async (tx) => {
        const row = await tx.vehicleTransfer.findFirst({
          where: { id },
          select: {
            id: true,
            vehicleId: true,
            fromCustomerId: true,
            toCustomerId: true,
            status: true,
            expiresAt: true,
          },
        });
        if (!row) {
          throw businessError('transfer.not_found', 404, 'Trasferimento non trovato.');
        }
        if (row.fromCustomerId !== customerId) {
          throw businessError(
            'transfer.confirmation.not_from_customer',
            403,
            'Non sei il cedente di questo trasferimento.',
          );
        }
        // A scheduler-flipped 'expired' status (PR3) is surfaced as 410, before
        // the generic wrong-state 422 below (mirrors the accept handler).
        if (row.status === 'expired' || row.expiresAt.getTime() < Date.now()) {
          throw businessError('transfer.confirmation.expired', 410, 'Trasferimento scaduto.');
        }
        // !toCustomerId is a data-invariant violation (a pending_seller_confirmation
        // row always has a recipient); guarded defensively under the same 422.
        if (row.status !== 'pending_seller_confirmation' || !row.toCustomerId) {
          throw businessError(
            'transfer.confirmation.not_pending_seller',
            422,
            'Trasferimento non in attesa di conferma del cedente.',
          );
        }

        await confirmTransferSwap(tx, {
          transferId: row.id,
          vehicleId: row.vehicleId,
          fromCustomerId: customerId,
          toCustomerId: row.toCustomerId,
          now: new Date(),
        });

        const updated = await tx.vehicleTransfer.findFirst({
          where: { id: row.id },
          select: TRANSFER_SELECT,
        });
        // TODO(F-CLI-notifications): notify the recipient that ownership
        // transferred (ownership_transfer push/email), post-commit.
        return { transfer: serializeTransfer(updated!) };
      });
    },
  );
};

export default meTransfersRoutes;
