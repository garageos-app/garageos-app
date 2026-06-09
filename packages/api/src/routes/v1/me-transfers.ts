import { Prisma } from '@garageos/database';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { businessError } from '../../lib/business-error.js';
import { serializeTransfer, TRANSFER_SELECT } from '../../lib/dtos/transfer.js';
import { generateTransferCode } from '../../lib/transfer-code.js';
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
          throw businessError('me.transfer.vehicle_not_found', 404, 'Veicolo non trovato.');
        }

        // BR-040: only the active owner may initiate.
        const active = vehicle.ownerships[0] ?? null;
        if (!active || active.customerId !== customerId) {
          throw businessError(
            'transfer.not_current_owner',
            403,
            'Non sei il proprietario attuale del veicolo.',
          );
        }

        // BR-046: pending/archived vehicles are not transferable.
        if (vehicle.status !== 'certified') {
          throw businessError(
            'transfer.vehicle_not_certified',
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
            'transfer.already_pending',
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
            // transfer_code is @unique — a collision retries with a fresh
            // code. Any other error propagates.
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
              lastErr = err;
              continue;
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
          throw businessError('me.transfer.not_found', 404, 'Trasferimento non trovato.');
        }
        return { transfer: serializeTransfer(row) };
      });
    },
  );
};

export default meTransfersRoutes;
