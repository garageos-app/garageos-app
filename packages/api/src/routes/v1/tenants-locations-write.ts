// POST/PATCH/DELETE /v1/tenants/me/locations — F-OFF-003 location CRUD.
// Super Admin only. See BR-200/BR-201/BR-204/BR-205 and the design spec
// docs/superpowers/specs/2026-06-01-F-OFF-003-location-crud-design.md.
//
// RLS: locations_read is permissive (USING true) so every read filters
// tenantId application-side; locations_write is tenant-scoped, so a
// withContext({ tenantId }) is sufficient for INSERT/UPDATE.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { businessError } from '../../lib/business-error.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { requireSuperAdmin } from '../../middleware/require-super-admin.js';
import { tenantContext } from '../../middleware/tenant-context.js';

const LOCATION_SELECT = {
  id: true,
  name: true,
  addressLine: true,
  city: true,
  province: true,
  postalCode: true,
  country: true,
  phone: true,
  email: true,
  isPrimary: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const;

// Shared field rules (regex mirrored from tenants-update.ts).
const name = z.string().trim().min(1).max(200);
const addressLine = z.string().trim().min(1).max(255);
const city = z.string().trim().min(1).max(100);
const province = z
  .string()
  .trim()
  .transform((s) => s.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{2}$/, 'Provincia: 2 lettere'));
const postalCode = z.string().regex(/^[0-9]{5}$/, 'CAP: 5 cifre');
// Base (no default) so PATCH `.partial()` does NOT auto-populate country
// on an empty body — that would defeat the empty_body guard and silently
// reset country to IT. The IT default is applied only in createSchema.
const country = z
  .string()
  .trim()
  .transform((s) => s.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{2}$/, 'Country: 2 lettere'));
const phone = z.string().regex(/^[+]?[0-9 ()-]{6,30}$/, 'Telefono non valido');
const email = z.email('Email non valida');

// POST body: all address fields required, isPrimary NOT accepted
// (a new location is always secondary; promotion happens via PATCH).
const createSchema = z
  .object({
    name,
    addressLine,
    city,
    province,
    postalCode,
    country: country.default('IT'),
    phone: phone.nullish(),
    email: email.nullish(),
  })
  .strict();

// PATCH body: every field optional; isPrimary accepted as boolean so the
// handler can return 422 cannot_unset_primary on explicit false (a bare
// z.literal(true) would surface a generic 400 instead).
const updateSchema = z
  .object({
    name,
    addressLine,
    city,
    province,
    postalCode,
    country,
    phone: phone.nullable(),
    email: email.nullable(),
    isPrimary: z.boolean(),
  })
  .partial()
  .strict();

const ADDRESS_KEYS = [
  'name',
  'addressLine',
  'city',
  'province',
  'postalCode',
  'country',
  'phone',
  'email',
] as const;

const tenantsLocationsWriteRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/v1/tenants/me/locations',
    { preHandler: [requireAuth, requireOfficinaPool, tenantContext, requireSuperAdmin] },
    async (request, reply) => {
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) {
        const hasUnknown = parsed.error.issues.some((i) => i.code === 'unrecognized_keys');
        if (hasUnknown) {
          throw businessError(
            'tenants.me.locations.update.unknown_field',
            422,
            'Campo non riconosciuto.',
          );
        }
        throw parsed.error;
      }
      const b = parsed.data;
      const tenantId = request.tenantId!;

      const created = await app.withContext({ tenantId }, (tx) =>
        tx.location.create({
          data: {
            tenantId,
            name: b.name,
            addressLine: b.addressLine,
            city: b.city,
            province: b.province,
            postalCode: b.postalCode,
            country: b.country,
            phone: b.phone ?? null,
            email: b.email ?? null,
            isPrimary: false,
            status: 'active',
          },
          select: LOCATION_SELECT,
        }),
      );

      return reply.code(201).send({ location: created });
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/v1/tenants/me/locations/:id',
    { preHandler: [requireAuth, requireOfficinaPool, tenantContext, requireSuperAdmin] },
    async (request) => {
      const parsed = updateSchema.safeParse(request.body);
      if (!parsed.success) {
        const hasUnknown = parsed.error.issues.some((i) => i.code === 'unrecognized_keys');
        if (hasUnknown) {
          throw businessError(
            'tenants.me.locations.update.unknown_field',
            422,
            'Campo non riconosciuto.',
          );
        }
        throw parsed.error;
      }
      const body = parsed.data;
      if (Object.keys(body).length === 0) {
        throw businessError(
          'tenants.me.locations.update.empty_body',
          422,
          'Specifica almeno un campo da aggiornare.',
        );
      }
      if (body.isPrimary === false) {
        throw businessError(
          'tenants.me.locations.cannot_unset_primary',
          422,
          'Per cambiare la sede primaria, designa un’altra sede come primaria.',
        );
      }

      const { id } = request.params;
      const tenantId = request.tenantId!;
      const promote = body.isPrimary === true;

      // Build the address patch (exactOptionalPropertyTypes-safe).
      const patch: Record<string, unknown> = {};
      for (const k of ADDRESS_KEYS) {
        if (k in body) patch[k] = body[k] ?? null;
      }

      return app.withContext({ tenantId }, async (tx) => {
        // Application-side tenant guard (SELECT RLS is permissive).
        const target = await tx.location.findFirst({
          where: { id, tenantId, deletedAt: null },
          select: { id: true },
        });
        if (!target) {
          throw businessError('tenants.me.locations.not_found', 404, 'Sede non trovata.');
        }

        if (promote) {
          // Demote the current active primary first to respect
          // uq_locations_tenant_primary (BR-201), then promote target.
          await tx.location.updateMany({
            where: { tenantId, isPrimary: true, status: 'active', deletedAt: null, NOT: { id } },
            data: { isPrimary: false },
          });
          patch.isPrimary = true;
        }

        const updated = await tx.location.update({
          where: { id },
          data: patch,
          select: LOCATION_SELECT,
        });
        return { location: updated };
      });
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/tenants/me/locations/:id',
    { preHandler: [requireAuth, requireOfficinaPool, tenantContext, requireSuperAdmin] },
    async (request) => {
      const { id } = request.params;
      const tenantId = request.tenantId!;

      return app.withContext({ tenantId }, async (tx) => {
        const target = await tx.location.findFirst({
          where: { id, tenantId, deletedAt: null },
          select: { id: true, isPrimary: true },
        });
        if (!target) {
          throw businessError('tenants.me.locations.not_found', 404, 'Sede non trovata.');
        }
        // BR-201: cannot deactivate the primary location.
        if (target.isPrimary) {
          throw businessError(
            'tenants.me.locations.cannot_delete_primary',
            422,
            'Designa prima un’altra sede come primaria.',
          );
        }
        // BR-204: a mechanic must have an active location — block
        // deactivation while active users are still assigned here.
        const activeUsers = await tx.user.count({
          where: { tenantId, locationId: id, status: 'active', deletedAt: null },
        });
        if (activeUsers > 0) {
          throw businessError(
            'tenants.me.locations.has_active_users',
            422,
            'Riassegna o disattiva prima i meccanici di questa sede.',
          );
        }

        const updated = await tx.location.update({
          where: { id },
          data: { status: 'inactive', deletedAt: new Date() },
          select: LOCATION_SELECT,
        });
        return { location: updated };
      });
    },
  );
};

export default tenantsLocationsWriteRoutes;
