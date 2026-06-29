// GET  /v1/admin/tenants/:id/users        — list a tenant's staff users (platform-admin)
// PATCH /v1/admin/tenants/:id/users/:userId — update a tenant user cross-tenant (platform-admin)
//
// Auth chain: requireAuth → requirePlatformAdminsPool. No tenantContext —
// platform admins are not tenant users and withContext({ role: 'admin' }) is
// used directly for all DB reads/writes.
//
// Security note: users_read RLS is USING(true) — it does NOT scope by tenant.
// The app-layer { tenantId: id } filter in every query is the ONLY cross-tenant
// scoping guard. Never omit it. See the integration test "cross-tenant 404"
// for the exact scenario this prevents.
//
// GET: lists all users (including soft-deleted, for "Disattivati" display) of
//   the given tenant. Mirrors users-list.ts but scoped to the path tenant.
//   Anti-enum: invalid UUID format → tenant.not_found 404 (same as unknown UUID).
//   Loads the tenant first so an unknown id returns 404 rather than empty [].
//
// PATCH: updates a tenant user's role/locationId/status cross-tenant.
//   Delegates all business-invariant logic to updateOfficineUser (BR-203
//   last-super_admin guard, BR-204 mechanic-requires-location, Cognito sync).
//   Passes defaultMechanicLocationToPrimary: true so the helper auto-defaults
//   to the primary location when making a user a mechanic with no effective
//   location. The defaulting is gated on the EFFECTIVE location — an already-
//   assigned mechanic is never relocated. See UpdateUserInput in update-user.ts.
//
// Business rules (delegated to updateOfficineUser):
//   BR-203 — last super_admin guard
//   BR-204 — mechanic location required (with pre-resolve defaulting here)
//
// Error codes (own):
//   tenant.not_found — 404: tenant unknown or soft-deleted
// Error codes (from updateOfficineUser):
//   user.not_found                       — 404: target missing or cross-tenant
//   user.last_super_admin                — 409: BR-203 violation
//   user.location_required_for_mechanic  — 422: BR-204 violation
//   user.location_invalid                — 422: locationId not in tenant or inactive

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { businessError } from '../../lib/business-error.js';
import { USER_ADMIN_SELECT, serializeUserAdmin } from '../../lib/dtos/user-admin.js';
import { updateOfficineUser } from '../../lib/user-management/update-user.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requirePlatformAdminsPool } from '../../middleware/require-platform-admins-pool.js';

const ParamsSchema = z.object({ id: z.string().uuid() });
const ParamsWithUserSchema = z.object({ id: z.string().uuid(), userId: z.string().uuid() });

// Same body shape as users-admin-update.ts — reused verbatim so both
// officine-local and platform-admin cross-tenant updates accept identical
// payloads. At-least-one refine mirrors the officine route exactly.
const BodySchema = z
  .object({
    role: z.enum(['super_admin', 'mechanic']).optional(),
    locationId: z.string().uuid().nullable().optional(),
    status: z.enum(['active', 'inactive']).optional(),
  })
  .refine((d) => d.role !== undefined || d.locationId !== undefined || d.status !== undefined, {
    message: 'At least one field (role, locationId, status) must be present',
  });

export const adminTenantUsersRoutes: FastifyPluginAsync = async (app) => {
  // ── GET /v1/admin/tenants/:id/users ──────────────────────────────────────────
  app.get(
    '/v1/admin/tenants/:id/users',
    {
      preHandler: [requireAuth, requirePlatformAdminsPool],
    },
    async (request, reply) => {
      // Anti-enum: invalid UUID format → 404, same as unknown tenant UUID.
      const parsedParams = ParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        throw businessError('tenant.not_found', 404, 'Officina non trovata.');
      }
      const { id } = parsedParams.data;

      const users = await app.withContext({ role: 'admin' as const }, async (tx) => {
        // Confirm tenant exists (not soft-deleted) before listing its users.
        // Without this check, an unknown id would silently return [] rather
        // than a 404, making the API ambiguous.
        const tenant = await tx.tenant.findFirst({
          where: { id, deletedAt: null },
          select: { id: true },
        });
        if (!tenant) {
          throw businessError('tenant.not_found', 404, 'Officina non trovata.');
        }

        // Cross-tenant guard: { tenantId: id } scopes to the path tenant.
        // users_read RLS is permissive (USING true) — this WHERE clause is
        // the ONLY boundary preventing cross-tenant data leaks.
        // Includes soft-deleted users (no deletedAt filter) so the UI can
        // display "Disattivati" rows. Mirrors users-list.ts.
        const rows = await tx.user.findMany({
          where: { tenantId: id },
          select: USER_ADMIN_SELECT,
          orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        });
        return rows.map(serializeUserAdmin);
      });

      return reply.code(200).send({ users });
    },
  );

  // ── PATCH /v1/admin/tenants/:id/users/:userId ─────────────────────────────────
  app.patch(
    '/v1/admin/tenants/:id/users/:userId',
    {
      preHandler: [requireAuth, requirePlatformAdminsPool],
    },
    async (request, reply) => {
      // Anti-enum: invalid UUID format for either param → 404.
      const parsedParams = ParamsWithUserSchema.safeParse(request.params);
      if (!parsedParams.success) {
        throw businessError('tenant.not_found', 404, 'Officina non trovata.');
      }
      const { id, userId } = parsedParams.data;

      const parsedBody = BodySchema.safeParse(request.body);
      if (!parsedBody.success) {
        throw parsedBody.error;
      }

      // Confirm tenant exists before delegating to updateOfficineUser, so
      // callers get tenant.not_found rather than user.not_found on a bad id.
      await app.withContext({ role: 'admin' as const }, async (tx) => {
        const tenant = await tx.tenant.findFirst({
          where: { id, deletedAt: null },
          select: { id: true },
        });
        if (!tenant) {
          throw businessError('tenant.not_found', 404, 'Officina non trovata.');
        }
      });

      // Delegate all business logic (BR-203, BR-204, Cognito sync, audit) to
      // updateOfficineUser. Actor type is 'system' because platform admins have
      // no tenant User row; their identity is captured in audit metadata via
      // actorCognitoSub. See UpdateUserActor in update-user.ts.
      // defaultMechanicLocationToPrimary: true enables the helper's BR-204
      // convenience defaulting — see UpdateUserInput for the guard semantics.
      const user = await updateOfficineUser(
        app,
        {
          tenantId: id,
          targetId: userId,
          body: parsedBody.data,
          defaultMechanicLocationToPrimary: true,
          // requireAuth guarantees request.jwt is set; Cognito JWTs always
          // include a non-empty sub. The double non-null asserts both.
          actor: { type: 'system', cognitoSub: request.jwt!.sub! },
          ip: request.ip,
        },
        request.log,
      );

      return reply.code(200).send({ user });
    },
  );
};
