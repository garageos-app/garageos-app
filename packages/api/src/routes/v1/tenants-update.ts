import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { businessError } from '../../lib/business-error.js';
import { TENANT_ME_SELECT } from '../../lib/dtos/tenant-me.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { requireSuperAdmin } from '../../middleware/require-super-admin.js';
import { tenantContext } from '../../middleware/tenant-context.js';

// PATCH /v1/tenants/me — APPENDICE_A §3.2, F-OFF-007 "Aggiorna dati tenant".
// Super Admin only — requireSuperAdmin middleware enforces the role
// boundary AFTER tenantContext populates request.userRole.
//
// Partial update with same body discipline as users-update: empty body
// rejected with tenants.me.update.empty_body (422), unknown fields
// rejected with tenants.me.update.unknown_field (422). Excluded from
// editable schema (intentionally not editable through this slice):
// vatNumber (legal, requires re-validation), status / plan /
// billingStatus (admin-internal / billing flow), createdAt (immutable).
// They are still returned by the response DTO for display.

// .strict() rejects unknown / non-editable keys. .partial() allows
// omission for partial PATCH.
const bodySchema = z
  .object({
    businessName: z.string().trim().min(1).max(200),
    addressLine: z.string().trim().max(255).nullable(),
    city: z.string().trim().max(100).nullable(),
    province: z
      .string()
      .trim()
      .transform((s) => s.toUpperCase())
      .pipe(z.string().regex(/^[A-Z]{2}$/, 'Provincia: 2 lettere'))
      .nullable(),
    postalCode: z
      .string()
      .regex(/^[0-9]{5}$/, 'CAP: 5 cifre')
      .nullable(),
    phone: z
      .string()
      .regex(/^[+]?[0-9 ()-]{6,30}$/, 'Telefono non valido')
      .nullable(),
    email: z.email('Email non valida').nullable(),
  })
  .partial()
  .strict();

const EDITABLE_KEYS = [
  'businessName',
  'addressLine',
  'city',
  'province',
  'postalCode',
  'phone',
  'email',
] as const;

const tenantUpdateRoutes: FastifyPluginAsync = async (app) => {
  app.patch(
    '/v1/tenants/me',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext, requireSuperAdmin],
    },
    async (request) => {
      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) {
        const hasUnknown = parsed.error.issues.some((i) => i.code === 'unrecognized_keys');
        if (hasUnknown) {
          throw businessError('tenants.me.update.unknown_field', 422, 'Campo non modificabile.');
        }
        // Re-raise so the global handler emits 400 VALIDATION_ERROR with
        // the canonical errors[] breakdown.
        throw parsed.error;
      }
      const body = parsed.data;
      if (Object.keys(body).length === 0) {
        throw businessError(
          'tenants.me.update.empty_body',
          422,
          'Specifica almeno un campo da aggiornare.',
        );
      }

      // Build patch with 'key' in body guards to satisfy
      // exactOptionalPropertyTypes: true. Same pattern as users-update.
      const patch: Record<string, unknown> = {};
      for (const key of EDITABLE_KEYS) {
        if (key in body) {
          patch[key] = body[key] ?? null;
        }
      }

      const tenantId = request.tenantId!;

      return app.withContext({ tenantId }, async (tx) =>
        tx.tenant.update({
          where: { id: tenantId },
          data: patch,
          select: TENANT_ME_SELECT,
        }),
      );
    },
  );
};

export default tenantUpdateRoutes;
