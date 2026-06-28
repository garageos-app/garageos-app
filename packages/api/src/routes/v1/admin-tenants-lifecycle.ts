// POST /v1/admin/tenants/:id/suspend   — BR-210 lifecycle: active → suspended
// POST /v1/admin/tenants/:id/reactivate — BR-210 lifecycle: suspended → active
//
// Both endpoints are platform-admin-only and are deliberately co-located here
// because they are symmetric and trivially small — the same logic mirrored.
//
// Auth chain: requireAuth → requirePlatformAdminsPool. No tenantContext —
// platform admins are not tenant users and withContext({ role: 'admin' }) is
// used directly for all DB writes.
//
// :id anti-enum pattern: an invalid UUID and an unknown UUID both surface as
// tenant.not_found 404 to avoid leaking existence information to callers.
//
// actorType:'system' in the audit log because platform admins have no tenant
// User row in the database — they exist only in the platform-admins Cognito
// pool. The Cognito sub is captured in metadata for traceability.
//
// See BR-210 in docs/APPENDICE_F_BUSINESS_LOGIC.md for the full lifecycle rule.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { businessError } from '../../lib/business-error.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requirePlatformAdminsPool } from '../../middleware/require-platform-admins-pool.js';

const ParamsSchema = z.object({ id: z.string().uuid() });

export const adminTenantsLifecycleRoutes: FastifyPluginAsync = async (app) => {
  // ── POST /v1/admin/tenants/:id/suspend ──────────────────────────────────────
  // BR-210: transitions a tenant from active → suspended.
  app.post(
    '/v1/admin/tenants/:id/suspend',
    {
      preHandler: [requireAuth, requirePlatformAdminsPool],
    },
    async (request, reply) => {
      // Anti-enum: invalid UUID format → 404, same as unknown UUID.
      const parsedParams = ParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        throw businessError('tenant.not_found', 404, 'Officina non trovata.');
      }
      const { id } = parsedParams.data;

      await app.withContext({ role: 'admin' as const }, async (tx) => {
        // BR-210: lookup tenant — null (unknown id) or soft-deleted → 404.
        const tenant = await tx.tenant.findFirst({
          where: { id, deletedAt: null },
          select: { id: true, status: true },
        });
        if (!tenant) {
          throw businessError('tenant.not_found', 404, 'Officina non trovata.');
        }

        // BR-210: only an active tenant can be suspended.
        // pending / suspended / cancelled all fail with tenant.invalid_status.
        if (tenant.status !== 'active') {
          throw businessError(
            'tenant.invalid_status',
            409,
            "L'officina non è in uno stato che permette la sospensione.",
          );
        }

        await tx.tenant.update({
          where: { id },
          data: { status: 'suspended' },
        });

        // Audit — in-tx so it rolls back atomically on failure.
        await tx.auditLog.create({
          data: {
            tenantId: id,
            actorType: 'system',
            actorId: null,
            action: 'tenant_suspended',
            entityType: 'tenant',
            entityId: id,
            metadata: {
              actorCognitoSub: request.jwt?.sub ?? null,
            },
            ipAddress: request.ip,
          },
        });
      });

      return reply.code(200).send({ tenant: { id, status: 'suspended' } });
    },
  );

  // ── POST /v1/admin/tenants/:id/reactivate ───────────────────────────────────
  // BR-210: transitions a tenant from suspended → active.
  app.post(
    '/v1/admin/tenants/:id/reactivate',
    {
      preHandler: [requireAuth, requirePlatformAdminsPool],
    },
    async (request, reply) => {
      // Anti-enum: invalid UUID format → 404, same as unknown UUID.
      const parsedParams = ParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        throw businessError('tenant.not_found', 404, 'Officina non trovata.');
      }
      const { id } = parsedParams.data;

      await app.withContext({ role: 'admin' as const }, async (tx) => {
        // BR-210: lookup tenant — null (unknown id) or soft-deleted → 404.
        const tenant = await tx.tenant.findFirst({
          where: { id, deletedAt: null },
          select: { id: true, status: true },
        });
        if (!tenant) {
          throw businessError('tenant.not_found', 404, 'Officina non trovata.');
        }

        // BR-210: only a suspended tenant can be reactivated.
        // active / pending / cancelled all fail with tenant.invalid_status.
        if (tenant.status !== 'suspended') {
          throw businessError(
            'tenant.invalid_status',
            409,
            "L'officina non è in uno stato che permette la riattivazione.",
          );
        }

        await tx.tenant.update({
          where: { id },
          data: { status: 'active' },
        });

        // Audit — in-tx so it rolls back atomically on failure.
        await tx.auditLog.create({
          data: {
            tenantId: id,
            actorType: 'system',
            actorId: null,
            action: 'tenant_reactivated',
            entityType: 'tenant',
            entityId: id,
            metadata: {
              actorCognitoSub: request.jwt?.sub ?? null,
            },
            ipAddress: request.ip,
          },
        });
      });

      return reply.code(200).send({ tenant: { id, status: 'active' } });
    },
  );
};
