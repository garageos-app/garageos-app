import type { FastifyPluginAsync } from 'fastify';

import { USER_ME_SELECT, serializeUserMe } from '../../lib/dtos/user-me.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

// GET /v1/users/me — APPENDICE_A §3.2, F-OFF-007 "Profilo utente corrente".
//
// Lookup key is `users.cognitoSub` (not users.id): `request.userId` is
// the Cognito sub after tenantContext runs — see
// src/middleware/tenant-context.ts for the contract note.
//
// The select list enumerates exactly the public-facing fields. It
// omits: cognitoSub (security — never expose the IdP linkage),
// deletedAt / updatedAt (internal churn), lastLoginAt (not in scope).
// Any handler that later needs those must either add them to the
// select explicitly or expose them through a separate DTO.
//
// RLS activation: `app.withContext({ tenantId }, tx => ...)` sets
// `app.current_tenant_id` inside the transaction — the policies in
// packages/database/prisma/migrations filter cross-tenant rows
// server-side. Without withContext the query would still "work" but
// could leak rows from other tenants if a bug lets the wrong tenantId
// through.
const userRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/users/me',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request) => {
      const tenantId = request.tenantId!;
      const cognitoSub = request.userId!;

      // Bind the lookup to (cognitoSub, tenantId) so a JWT issued by
      // tenant A's pool that carries a sub belonging to tenant B's user
      // produces a clean 404 instead of leaking the cross-tenant row.
      // Pre-migration 0004 the single `users_tenant_isolation` policy
      // enforced this defense-in-depth at the RLS layer; post-0004
      // `users_read FOR SELECT USING (true)` is permissive, so the
      // tenant boundary is now an application-layer concern.
      return app.withContext({ tenantId }, async (tx) => {
        const row = await tx.user.findFirstOrThrow({
          where: { cognitoSub, tenantId },
          select: USER_ME_SELECT,
        });
        return serializeUserMe(row);
      });
    },
  );
};

export default userRoutes;
