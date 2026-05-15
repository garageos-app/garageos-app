import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { businessError } from '../../lib/business-error.js';
import { USER_ME_SELECT, serializeUserMe } from '../../lib/dtos/user-me.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

// PATCH /v1/users/me — APPENDICE_A §3.3, F-OFF-007 "Aggiorna profilo".
// Partial update: only fields present in body are mutated. Empty body
// rejected with users.me.update.empty_body (422). Unknown keys
// rejected with users.me.update.unknown_field (422) — defense in depth
// against clients trying to mutate non-editable fields like role,
// email, cognitoSub, status.
//
// Cross-tenant guard: findFirstOrThrow({ cognitoSub, tenantId }) before
// update. Post-migration 0004 users SELECT is permissive — application
// layer must enforce the tenant boundary (see users.ts header comment
// for the full rationale).

// .strict() rejects unknown keys (email, role, cognitoSub, status,
// etc.) so the immutable-field invariant is testable. .partial()
// allows omission of fields for partial PATCH.
const bodySchema = z
  .object({
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    phone: z
      .string()
      .regex(/^[+]?[0-9 ()-]{6,30}$/, 'Telefono non valido')
      .nullable(),
  })
  .partial()
  .strict();

const userUpdateRoutes: FastifyPluginAsync = async (app) => {
  app.patch(
    '/v1/users/me',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request) => {
      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) {
        const hasUnknown = parsed.error.issues.some((i) => i.code === 'unrecognized_keys');
        if (hasUnknown) {
          throw businessError('users.me.update.unknown_field', 422, 'Campo non modificabile.');
        }
        // Re-raise so the global handler emits 400 VALIDATION_ERROR with
        // the canonical errors[] breakdown.
        throw parsed.error;
      }
      const body = parsed.data;
      if (Object.keys(body).length === 0) {
        throw businessError(
          'users.me.update.empty_body',
          422,
          'Specifica almeno un campo da aggiornare.',
        );
      }

      const tenantId = request.tenantId!;
      const cognitoSub = request.userId!;

      return app.withContext({ tenantId }, async (tx) => {
        // Bind lookup to (cognitoSub, tenantId) — defense in depth
        // against a JWT with a sub from another tenant returning a row
        // under the permissive SELECT USING (true) post-migration 0004
        // policy. findFirstOrThrow produces a clean 404 on mismatch
        // (P2025 → global error handler → 404).
        const existing = await tx.user.findFirstOrThrow({
          where: { cognitoSub, tenantId },
          select: { id: true },
        });

        // exactOptionalPropertyTypes: Prisma's update data type does not
        // accept `undefined` as a value (it uses optional properties, not
        // T | undefined). Build the patch object with only the keys that
        // are actually present in the body so undefined properties are
        // never included — mirrors the ANAGRAFICA_KEYS loop in
        // customers-update.ts.
        const patch: Record<string, string | null> = {};
        if ('firstName' in body) patch['firstName'] = body.firstName!;
        if ('lastName' in body) patch['lastName'] = body.lastName!;
        if ('phone' in body) patch['phone'] = body.phone ?? null;

        const updated = await tx.user.update({
          where: { id: existing.id },
          data: patch,
          select: USER_ME_SELECT,
        });
        return serializeUserMe(updated);
      });
    },
  );
};

export default userUpdateRoutes;
