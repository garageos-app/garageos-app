// GET  /v1/admin/tenants/:id  — view any tenant's profile (platform-admin only).
// PATCH /v1/admin/tenants/:id — edit any tenant's profile, including vatNumber.
//
// Key differences from the officine PATCH /v1/tenants/me:
//   - Platform admin CAN edit vatNumber (the officine endpoint deliberately
//     excludes it — legal field requiring re-validation).
//   - No tenantContext middleware — platform admins are not tenant users and
//     exist only in the platform-admins Cognito pool.
//   - actorType:'system' in audit log; the Cognito sub is captured in metadata.
//
// :id anti-enum pattern: an invalid UUID and an unknown UUID both surface as
// tenant.not_found 404 to avoid leaking existence information to callers.
//
// Auth chain: requireAuth → requirePlatformAdminsPool. No rate-limit.
// withContext({ role: 'admin' }) for all DB operations.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { Prisma, VatNumberSchema } from '@garageos/database';
import { businessError } from '../../lib/business-error.js';
import { serializeTenantMe, TENANT_ME_SELECT_WITH_SETTINGS } from '../../lib/dtos/tenant-me.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requirePlatformAdminsPool } from '../../middleware/require-platform-admins-pool.js';

const ParamsSchema = z.object({ id: z.string().uuid() });

// Body schema mirrors tenants-update.ts body plus vatNumber.
// .partial() allows partial PATCH; .strict() rejects unknown keys.
// No .default() on any field — empty body is caught explicitly below.
const bodySchema = z
  .object({
    businessName: z.string().trim().min(1).max(200),
    vatNumber: z.string().trim().min(1).max(20),
    email: z.email('Email non valida'),
    phone: z
      .string()
      .regex(/^[+]?[0-9 ()-]{6,30}$/, 'Telefono non valido')
      .nullable(),
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
  })
  .partial()
  .strict();

// All fields the admin may write through this endpoint.
// vatNumber is included here (unlike the officine PATCH body).
// Build patch with 'key' in body guards to satisfy exactOptionalPropertyTypes.
const EDITABLE_KEYS = [
  'businessName',
  'vatNumber',
  'email',
  'phone',
  'addressLine',
  'city',
  'province',
  'postalCode',
] as const;

export const adminTenantDetailRoutes: FastifyPluginAsync = async (app) => {
  // ── GET /v1/admin/tenants/:id ────────────────────────────────────────────────
  app.get(
    '/v1/admin/tenants/:id',
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

      const row = await app.withContext({ role: 'admin' as const }, async (tx) => {
        const tenant = await tx.tenant.findFirst({
          where: { id, deletedAt: null },
          select: TENANT_ME_SELECT_WITH_SETTINGS,
        });
        if (!tenant) throw businessError('tenant.not_found', 404, 'Officina non trovata.');
        return tenant;
      });

      return reply.code(200).send({ tenant: serializeTenantMe(row) });
    },
  );

  // ── PATCH /v1/admin/tenants/:id ──────────────────────────────────────────────
  app.patch(
    '/v1/admin/tenants/:id',
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

      // Body parsing — mirror tenants-update.ts:67-84.
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

      // Manual VAT format check: the Zod body only enforces presence/length.
      // VatNumberSchema from the database package enforces the 11-digit rule.
      if ('vatNumber' in body) {
        if (!VatNumberSchema.safeParse(body.vatNumber).success) {
          throw businessError(
            'tenant.vat_number_invalid',
            400,
            'P.IVA non valida: deve essere di 11 cifre.',
          );
        }
      }

      // Build patch with 'key' in body guards to satisfy
      // exactOptionalPropertyTypes: true. Same pattern as tenants-update.ts:88-93.
      const patch: Record<string, unknown> = {};
      for (const key of EDITABLE_KEYS) {
        if (key in body) {
          patch[key] = body[key] ?? null;
        }
      }

      const updatedRow = await app.withContext({ role: 'admin' as const }, async (tx) => {
        // Existence check before update — null → tenant.not_found 404.
        const existing = await tx.tenant.findFirst({
          where: { id, deletedAt: null },
          select: { id: true },
        });
        if (!existing) throw businessError('tenant.not_found', 404, 'Officina non trovata.');

        // Update with P2002 → vat_number_duplicate mapping.
        // Mirror admin-tenants-create.ts P2002 handling.
        let row;
        try {
          row = await tx.tenant.update({
            where: { id },
            data: patch,
            select: TENANT_ME_SELECT_WITH_SETTINGS,
          });
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            throw businessError('tenant.vat_number_duplicate', 409, 'P.IVA già registrata.');
          }
          throw err;
        }

        // Audit log — in-tx so it rolls back atomically on failure.
        // actorType:'system' because platform admins have no tenant User row;
        // the Cognito sub is captured in metadata for traceability.
        await tx.auditLog.create({
          data: {
            tenantId: id,
            actorType: 'system',
            actorId: null,
            action: 'tenant_profile_updated',
            entityType: 'tenant',
            entityId: id,
            metadata: {
              actorCognitoSub: request.jwt?.sub ?? null,
              changed: Object.keys(patch),
            },
            ipAddress: request.ip,
          },
        });

        return row;
      });

      return reply.code(200).send({ tenant: serializeTenantMe(updatedRow) });
    },
  );
};
