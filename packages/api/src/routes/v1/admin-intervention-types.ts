// GET    /v1/admin/intervention-types      — list the GLOBAL catalog (incl. inactive)
// POST   /v1/admin/intervention-types      — create a new global type
// PATCH  /v1/admin/intervention-types/:id  — edit an existing global type
// DELETE /v1/admin/intervention-types/:id  — hard-delete a global type
//
// BR-306: catalogo scrivibile solo dal platform admin
// (requirePlatformAdminsPool + RLS is_admin_role()). No tenantContext
// middleware — platform admins are not tenant users.
//
// Auth chain: requireAuth → requirePlatformAdminsPool. All DB access goes
// through app.withContext({ role: 'admin' }) so the intervention_types_isolation
// RLS policy passes via is_admin_role().
//
// Global-type `code` uniqueness is enforced at the APPLICATION layer, not
// the DB: uq_intervention_type_code_tenant is (tenant_id, code) with
// default NULLS-DISTINCT semantics, so two rows with tenant_id IS NULL and
// the same code do NOT collide at the DB level — P2002 never fires for
// this case. The findFirst pre-check below is therefore load-bearing, not
// a redundant belt-and-braces check. A residual TOCTOU race between the
// pre-check and the create is accepted here: this is a single-operator
// catalog (platform admins only), not a public-facing endpoint.
//
// DELETE is a hard delete: Intervention.interventionType is onDelete:
// Restrict, so deleting a type referenced by an intervention throws P2003 —
// mapped to 409 admin.intervention_type.in_use. Checklist items and tenant
// exclusions cascade automatically (onDelete: Cascade on those FKs).

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { Prisma } from '@garageos/database';
import { businessError } from '../../lib/business-error.js';
import {
  CodeSchema,
  INTERVENTION_TYPE_ADMIN_SELECT,
  serializeInterventionTypeAdmin,
} from '../../lib/dtos/intervention-type-admin.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requirePlatformAdminsPool } from '../../middleware/require-platform-admins-pool.js';

const ParamsSchema = z.object({ id: z.string().uuid() });

const CreateTypeBody = z
  .object({
    code: CodeSchema,
    nameIt: z.string().trim().min(1).max(150),
    description: z.string().trim().max(1000).optional(),
    icon: z.string().trim().max(50).optional(),
    suggestsDeadline: z.boolean().optional().default(false),
    defaultDeadlineMonths: z.number().int().positive().max(600).nullable().optional(),
    defaultDeadlineKm: z.number().int().positive().max(2_000_000).nullable().optional(),
    active: z.boolean().optional().default(true),
  })
  .strict();

// code is immutable after creation (not part of this schema).
// Field definitions otherwise mirror CreateTypeBody exactly (brief: "come
// sopra"), just made optional so a partial PATCH body validates.
const UpdateTypeBody = z
  .object({
    nameIt: z.string().trim().min(1).max(150).optional(),
    // Nullable: PATCH { description: null } explicitly clears a previously
    // set value (columns are String? in schema.prisma). Distinct from
    // omitting the key entirely, which leaves the current value untouched.
    description: z.string().trim().max(1000).nullable().optional(),
    icon: z.string().trim().max(50).nullable().optional(),
    suggestsDeadline: z.boolean().optional(),
    defaultDeadlineMonths: z.number().int().positive().max(600).nullable().optional(),
    defaultDeadlineKm: z.number().int().positive().max(2_000_000).nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'Almeno un campo da aggiornare' });

const UPDATE_EDITABLE_KEYS = [
  'nameIt',
  'description',
  'icon',
  'suggestsDeadline',
  'defaultDeadlineMonths',
  'defaultDeadlineKm',
  'active',
] as const;

export const adminInterventionTypesRoutes: FastifyPluginAsync = async (app) => {
  // ── GET /v1/admin/intervention-types ─────────────────────────────────────────
  app.get(
    '/v1/admin/intervention-types',
    { preHandler: [requireAuth, requirePlatformAdminsPool] },
    async (_request, reply) => {
      const rows = await app.withContext({ role: 'admin' as const }, (tx) =>
        tx.interventionType.findMany({
          where: { tenantId: null },
          orderBy: [{ nameIt: 'asc' }],
          select: INTERVENTION_TYPE_ADMIN_SELECT,
        }),
      );
      return reply.code(200).send({ data: rows.map(serializeInterventionTypeAdmin) });
    },
  );

  // ── POST /v1/admin/intervention-types ─────────────────────────────────────────
  app.post(
    '/v1/admin/intervention-types',
    { preHandler: [requireAuth, requirePlatformAdminsPool] },
    async (request, reply) => {
      const parsed = CreateTypeBody.safeParse(request.body);
      if (!parsed.success) throw parsed.error;
      const body = parsed.data;

      const row = await app.withContext({ role: 'admin' as const }, async (tx) => {
        // App-layer uniqueness pre-check — see file header comment for why
        // this cannot be a P2002 catch.
        const existing = await tx.interventionType.findFirst({
          where: { tenantId: null, code: body.code },
          select: { id: true },
        });
        if (existing) {
          throw businessError(
            'admin.intervention_type.code_conflict',
            409,
            'Esiste già un tipo globale con questo codice.',
          );
        }

        const created = await tx.interventionType.create({
          data: {
            tenantId: null,
            code: body.code,
            nameIt: body.nameIt,
            description: body.description ?? null,
            icon: body.icon ?? null,
            suggestsDeadline: body.suggestsDeadline,
            defaultDeadlineMonths: body.defaultDeadlineMonths ?? null,
            defaultDeadlineKm: body.defaultDeadlineKm ?? null,
            active: body.active,
          },
          select: INTERVENTION_TYPE_ADMIN_SELECT,
        });

        await tx.auditLog.create({
          data: {
            tenantId: null,
            actorType: 'system',
            actorId: null,
            action: 'intervention_type_created',
            entityType: 'intervention_type',
            entityId: created.id,
            metadata: { actorCognitoSub: request.jwt?.sub ?? null },
            ipAddress: request.ip,
          },
        });

        return created;
      });

      return reply.code(201).send({ interventionType: serializeInterventionTypeAdmin(row) });
    },
  );

  // ── PATCH /v1/admin/intervention-types/:id ────────────────────────────────────
  app.patch(
    '/v1/admin/intervention-types/:id',
    { preHandler: [requireAuth, requirePlatformAdminsPool] },
    async (request, reply) => {
      // Anti-enum: invalid UUID format → same 404 as unknown UUID.
      const parsedParams = ParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        throw businessError(
          'admin.intervention_type.not_found',
          404,
          'Tipo di intervento non trovato.',
        );
      }
      const { id } = parsedParams.data;

      const parsed = UpdateTypeBody.safeParse(request.body);
      if (!parsed.success) throw parsed.error;
      const body = parsed.data;

      // Build patch with 'key' in body guards to satisfy
      // exactOptionalPropertyTypes: true (same pattern as admin-tenant-detail.ts).
      const patch: Record<string, unknown> = {};
      for (const key of UPDATE_EDITABLE_KEYS) {
        if (key in body) {
          patch[key] = body[key] ?? null;
        }
      }

      const row = await app.withContext({ role: 'admin' as const }, async (tx) => {
        const existing = await tx.interventionType.findFirst({
          where: { id, tenantId: null },
          select: { id: true },
        });
        if (!existing) {
          throw businessError(
            'admin.intervention_type.not_found',
            404,
            'Tipo di intervento non trovato.',
          );
        }

        const updated = await tx.interventionType.update({
          where: { id },
          data: patch,
          select: INTERVENTION_TYPE_ADMIN_SELECT,
        });

        await tx.auditLog.create({
          data: {
            tenantId: null,
            actorType: 'system',
            actorId: null,
            action: 'intervention_type_updated',
            entityType: 'intervention_type',
            entityId: id,
            metadata: { actorCognitoSub: request.jwt?.sub ?? null, changed: Object.keys(patch) },
            ipAddress: request.ip,
          },
        });

        return updated;
      });

      return reply.code(200).send({ interventionType: serializeInterventionTypeAdmin(row) });
    },
  );

  // ── DELETE /v1/admin/intervention-types/:id ───────────────────────────────────
  app.delete(
    '/v1/admin/intervention-types/:id',
    { preHandler: [requireAuth, requirePlatformAdminsPool] },
    async (request, reply) => {
      const parsedParams = ParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        throw businessError(
          'admin.intervention_type.not_found',
          404,
          'Tipo di intervento non trovato.',
        );
      }
      const { id } = parsedParams.data;

      await app.withContext({ role: 'admin' as const }, async (tx) => {
        const existing = await tx.interventionType.findFirst({
          where: { id, tenantId: null },
          select: { id: true },
        });
        if (!existing) {
          throw businessError(
            'admin.intervention_type.not_found',
            404,
            'Tipo di intervento non trovato.',
          );
        }

        try {
          await tx.interventionType.delete({ where: { id } });
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
            throw businessError(
              'admin.intervention_type.in_use',
              409,
              'Tipo in uso da uno o più interventi o scadenze: disattivalo invece di eliminarlo.',
            );
          }
          throw err;
        }

        await tx.auditLog.create({
          data: {
            tenantId: null,
            actorType: 'system',
            actorId: null,
            action: 'intervention_type_deleted',
            entityType: 'intervention_type',
            entityId: id,
            metadata: { actorCognitoSub: request.jwt?.sub ?? null },
            ipAddress: request.ip,
          },
        });
      });

      return reply.code(204).send();
    },
  );
};

export default adminInterventionTypesRoutes;
