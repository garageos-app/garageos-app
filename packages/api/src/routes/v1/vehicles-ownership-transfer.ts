// POST /v1/vehicles/:id/ownership-transfer — F-OFF-110 officina-mediated
// single-step vehicle transfer (BR-049, see spec
// docs/superpowers/specs/2026-05-21-f-off-110-officina-mediated-transfer-design.md).
//
// Auth chain: requireAuth → requireOfficinaPool → tenantContext
// Role: super_admin OR mechanic (both can execute transfers; mechanic
// is the common in-store actor).
// RLS context: role: 'admin' for writes (memory feedback_withcontext_empty_blocks_rls_writes).
//
// Error codes (see APPENDICE_G):
//   vehicle.transfer.role_denied              — 403
//   vehicle.not_found                         — 404
//   vehicle.transfer.pending_not_transferable — 422 BR-046
//   vehicle.transfer.archived                 — 422
//   vehicle.transfer.no_active_ownership      — 422
//   vehicle.transfer.active_transfer_exists   — 409 BR-047
//   vehicle.transfer.same_owner               — 409
//   vehicle.transfer.recipient_not_found      — 422

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { businessError } from '../../lib/business-error.js';
import { performOwnershipTransfer } from '../../lib/ownership-transfer.js';
import { vehicleDetailSelect } from '../../lib/vehicle-shared.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

const ParamsSchema = z.object({ id: z.uuid() });

const RecipientExistingSchema = z.object({
  kind: z.literal('existing'),
  customerId: z.uuid(),
});

const RecipientNewSchema = z.object({
  kind: z.literal('new'),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(255),
  phone: z.string().trim().max(30).nullable().optional(),
  codiceFiscale: z.string().trim().max(20).nullable().optional(),
  isBusiness: z.boolean().optional(),
  businessName: z.string().trim().max(200).nullable().optional(),
  vatNumber: z.string().trim().max(20).nullable().optional(),
});

const BodySchema = z
  .object({
    recipient: z.discriminatedUnion('kind', [RecipientExistingSchema, RecipientNewSchema]),
    reason: z.enum(['purchase', 'inheritance', 'company_assignment', 'other']),
    notes: z.string().trim().max(1000).nullable().optional(),
  })
  .refine(
    (b) => {
      if (b.recipient.kind === 'new' && b.recipient.isBusiness === true) {
        return Boolean(b.recipient.businessName && b.recipient.vatNumber);
      }
      return true;
    },
    {
      message: 'businessName and vatNumber required when isBusiness=true',
      path: ['recipient'],
    },
  );

export const vehiclesOwnershipTransferRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/v1/vehicles/:id/ownership-transfer',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request, reply) => {
      const parsedParams = ParamsSchema.safeParse(request.params);
      if (!parsedParams.success) throw parsedParams.error;
      const parsedBody = BodySchema.safeParse(request.body);
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
      const cognitoSub = request.userId!;
      const vehicleId = parsedParams.data.id;
      const body = parsedBody.data;

      const result = await app.withContext({ role: 'admin' as const }, async (tx) => {
        // tenant-context middleware already validated the user exists+active+
        // same-tenant — refetch the DB id (required for AccessLog FK).
        // findFirstOrThrow throws P2025 → 500 if absent (treat as unexpected).
        const actor = await tx.user.findFirstOrThrow({
          where: { cognitoSub, tenantId, deletedAt: null },
          select: { id: true },
        });

        return performOwnershipTransfer(tx, {
          vehicleId,
          tenantId,
          actorUserId: actor.id,
          recipient: body.recipient,
          reason: body.reason,
          notes: body.notes ?? null,
        });
      });

      const vehicle = await app.prisma.vehicle.findUniqueOrThrow({
        where: { id: vehicleId },
        select: vehicleDetailSelect,
      });

      return reply.code(200).send({
        vehicle,
        ownership: {
          id: result.ownership.id,
          customerId: result.ownership.customerId,
          startedAt: result.ownership.startedAt.toISOString(),
        },
        transfer: {
          id: result.transfer.id,
          status: result.transfer.status,
          completedAt: result.transfer.completedAt.toISOString(),
          reason: result.transfer.reason,
          notes: result.transfer.notes,
        },
      });
    },
  );
};
