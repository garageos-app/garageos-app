// GET /v1/admin/me — Slice 0 platform-admin identity endpoint.
//
// Auth chain: requireAuth → requirePlatformAdminsPool
// No tenant context: platform admins operate across all tenants and carry
// no tenant claims in their JWT.
//
// Returns identity fields extracted from the verified JWT without any DB
// lookup. Minimal and stable — later slices may extend the response body.

import type { FastifyPluginAsync } from 'fastify';

import { requireAuth } from '../../middleware/require-auth.js';
import { requirePlatformAdminsPool } from '../../middleware/require-platform-admins-pool.js';

export const adminMeRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/admin/me',
    {
      preHandler: [requireAuth, requirePlatformAdminsPool],
    },
    async (request, reply) => {
      const jwt = request.jwt!;
      return reply.code(200).send({
        sub: jwt.sub ?? '',
        email: jwt.email ?? '',
        firstName: jwt.given_name ?? '',
        lastName: jwt.family_name ?? '',
      });
    },
  );
};
