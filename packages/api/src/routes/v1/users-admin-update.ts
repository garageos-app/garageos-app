// PATCH /v1/users/:id — F-OFF-004 admin update user role/location/status.
//
// Auth chain: requireAuth → requireOfficinaPool → tenantContext → requireSuperAdmin
// RLS context: role: 'admin' required for writes.
//
// Business rules enforced (delegated to updateOfficineUser helper):
//   BR-203 — last super_admin guard
//   BR-204 — mechanic location required
//
// Error codes:
//   user.not_found                       — 404: target missing or cross-tenant
//   user.last_super_admin                — 409: BR-203 violation
//   user.location_required_for_mechanic  — 422: BR-204 violation
//   user.location_invalid                — 422: locationId not in tenant or inactive

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';
import { requireSuperAdmin } from '../../middleware/require-super-admin.js';
import { updateOfficineUser } from '../../lib/user-management/update-user.js';

const ParamsSchema = z.object({ id: z.string().uuid() });

const BodySchema = z
  .object({
    role: z.enum(['super_admin', 'mechanic']).optional(),
    locationId: z.string().uuid().nullable().optional(),
    status: z.enum(['active', 'inactive']).optional(),
  })
  .refine((d) => d.role !== undefined || d.locationId !== undefined || d.status !== undefined, {
    message: 'At least one field (role, locationId, status) must be present',
  });

export const usersAdminUpdateRoutes: FastifyPluginAsync = async (app) => {
  app.patch(
    '/v1/users/:id',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext, requireSuperAdmin],
    },
    async (request, reply) => {
      const parsedParams = ParamsSchema.safeParse(request.params);
      if (!parsedParams.success) throw parsedParams.error;

      const parsedBody = BodySchema.safeParse(request.body);
      if (!parsedBody.success) throw parsedBody.error;

      const user = await updateOfficineUser(
        app,
        {
          tenantId: request.tenantId!,
          targetId: parsedParams.data.id,
          body: parsedBody.data,
          actor: { type: 'user', cognitoSub: request.userId! },
          ip: request.ip,
        },
        request.log,
      );
      return reply.code(200).send({ user });
    },
  );
};
