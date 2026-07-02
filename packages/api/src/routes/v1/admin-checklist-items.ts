// GET    /v1/admin/intervention-types/:id/checklist-items — list a type's checklist items (incl. inactive)
// POST   /v1/admin/intervention-types/:id/checklist-items — create a checklist item under a type
// PATCH  /v1/admin/checklist-items/:id                    — edit an existing checklist item
// DELETE /v1/admin/checklist-items/:id                    — hard-delete a checklist item
//
// BR-306: catalogo scrivibile solo dal platform admin
// (requirePlatformAdminsPool + RLS is_admin_role()). No tenantContext
// middleware — platform admins are not tenant users.
//
// Auth chain: requireAuth → requirePlatformAdminsPool. All DB access goes
// through app.withContext({ role: 'admin' }) so the checklist-item RLS
// policy passes via is_admin_role().
//
// Route shape: GET/POST are NESTED under the parent type (the list is
// meaningless without a type, and creation always targets one type), so
// both existence-check the PARENT type first and 404
// admin.intervention_type.not_found (same code as Task 1's type routes —
// there is no separate "checklist item's type" 404). PATCH/DELETE are FLAT
// on the item id (editing/removing a single item does not need the parent
// in the URL) and 404 admin.checklist_item.not_found.
//
// BR-307: code univoco per tipo (uq_checklist_item_code_type → P2002).
// Unlike Task 1's global-type code uniqueness, this one CAN rely on a
// P2002 catch: uq_checklist_item_code_type is (intervention_type_id, code)
// and BOTH columns are NOT NULL, so two rows with the same
// (intervention_type_id, code) always collide at the DB level (no
// NULLS-DISTINCT loophole). No app-layer pre-check needed.
//
// DELETE is a hard delete: InterventionChecklistSelection.checklistItem is
// onDelete: SetNull, so deleting an item referenced by historical
// selections nulls checklist_item_id there while label_snapshot (already a
// point-in-time copy) is untouched (BR-303/D8). No P2003 concern — unlike
// Task 1's intervention-type DELETE, there is no Restrict FK to catch here.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { Prisma } from '@garageos/database';
import { businessError } from '../../lib/business-error.js';
import {
  CHECKLIST_ITEM_ADMIN_SELECT,
  CodeSchema,
  serializeChecklistItemAdmin,
} from '../../lib/dtos/intervention-type-admin.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requirePlatformAdminsPool } from '../../middleware/require-platform-admins-pool.js';

const TypeParamsSchema = z.object({ id: z.string().uuid() });
const ItemParamsSchema = z.object({ id: z.string().uuid() });

const CreateItemBody = z
  .object({
    code: CodeSchema,
    nameIt: z.string().trim().min(1).max(150),
    sortOrder: z.number().int().min(0).max(32767).optional().default(0),
    active: z.boolean().optional().default(true),
  })
  .strict();

const UpdateItemBody = z
  .object({
    nameIt: z.string().trim().min(1).max(150).optional(),
    sortOrder: z.number().int().min(0).max(32767).optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'Almeno un campo da aggiornare' });

const UPDATE_EDITABLE_KEYS = ['nameIt', 'sortOrder', 'active'] as const;

export const adminChecklistItemsRoutes: FastifyPluginAsync = async (app) => {
  // ── GET /v1/admin/intervention-types/:id/checklist-items ─────────────────────
  app.get(
    '/v1/admin/intervention-types/:id/checklist-items',
    { preHandler: [requireAuth, requirePlatformAdminsPool] },
    async (request, reply) => {
      // Anti-enum: invalid UUID format → same 404 as unknown UUID.
      const parsedParams = TypeParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        throw businessError(
          'admin.intervention_type.not_found',
          404,
          'Tipo di intervento non trovato.',
        );
      }
      const { id } = parsedParams.data;

      const rows = await app.withContext({ role: 'admin' as const }, async (tx) => {
        const type = await tx.interventionType.findFirst({
          where: { id, tenantId: null },
          select: { id: true },
        });
        if (!type) {
          throw businessError(
            'admin.intervention_type.not_found',
            404,
            'Tipo di intervento non trovato.',
          );
        }

        return tx.interventionChecklistItem.findMany({
          where: { interventionTypeId: id },
          orderBy: [{ sortOrder: 'asc' }, { nameIt: 'asc' }],
          select: CHECKLIST_ITEM_ADMIN_SELECT,
        });
      });

      return reply.code(200).send({ data: rows.map(serializeChecklistItemAdmin) });
    },
  );

  // ── POST /v1/admin/intervention-types/:id/checklist-items ────────────────────
  app.post(
    '/v1/admin/intervention-types/:id/checklist-items',
    { preHandler: [requireAuth, requirePlatformAdminsPool] },
    async (request, reply) => {
      const parsedParams = TypeParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        throw businessError(
          'admin.intervention_type.not_found',
          404,
          'Tipo di intervento non trovato.',
        );
      }
      const { id } = parsedParams.data;

      const parsed = CreateItemBody.safeParse(request.body);
      if (!parsed.success) throw parsed.error;
      const body = parsed.data;

      const row = await app.withContext({ role: 'admin' as const }, async (tx) => {
        const type = await tx.interventionType.findFirst({
          where: { id, tenantId: null },
          select: { id: true },
        });
        if (!type) {
          throw businessError(
            'admin.intervention_type.not_found',
            404,
            'Tipo di intervento non trovato.',
          );
        }

        let created;
        try {
          created = await tx.interventionChecklistItem.create({
            data: {
              interventionTypeId: id,
              code: body.code,
              nameIt: body.nameIt,
              sortOrder: body.sortOrder,
              active: body.active,
            },
            select: CHECKLIST_ITEM_ADMIN_SELECT,
          });
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            throw businessError(
              'admin.checklist_item.code_conflict',
              409,
              'Esiste già una voce con questo codice per il tipo selezionato.',
            );
          }
          throw err;
        }

        await tx.auditLog.create({
          data: {
            tenantId: null,
            actorType: 'system',
            actorId: null,
            action: 'checklist_item_created',
            entityType: 'intervention_checklist_item',
            entityId: created.id,
            metadata: { actorCognitoSub: request.jwt?.sub ?? null },
            ipAddress: request.ip,
          },
        });

        return created;
      });

      return reply.code(201).send({ checklistItem: serializeChecklistItemAdmin(row) });
    },
  );

  // ── PATCH /v1/admin/checklist-items/:id ───────────────────────────────────────
  app.patch(
    '/v1/admin/checklist-items/:id',
    { preHandler: [requireAuth, requirePlatformAdminsPool] },
    async (request, reply) => {
      // Anti-enum: invalid UUID format → same 404 as unknown UUID.
      const parsedParams = ItemParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        throw businessError('admin.checklist_item.not_found', 404, 'Voce checklist non trovata.');
      }
      const { id } = parsedParams.data;

      const parsed = UpdateItemBody.safeParse(request.body);
      if (!parsed.success) throw parsed.error;
      const body = parsed.data;

      // Build patch with 'key' in body guards to satisfy
      // exactOptionalPropertyTypes: true (same pattern as admin-intervention-types.ts).
      const patch: Record<string, unknown> = {};
      for (const key of UPDATE_EDITABLE_KEYS) {
        if (key in body) {
          patch[key] = body[key] ?? null;
        }
      }

      const row = await app.withContext({ role: 'admin' as const }, async (tx) => {
        const existing = await tx.interventionChecklistItem.findFirst({
          where: { id },
          select: { id: true },
        });
        if (!existing) {
          throw businessError('admin.checklist_item.not_found', 404, 'Voce checklist non trovata.');
        }

        const updated = await tx.interventionChecklistItem.update({
          where: { id },
          data: patch,
          select: CHECKLIST_ITEM_ADMIN_SELECT,
        });

        await tx.auditLog.create({
          data: {
            tenantId: null,
            actorType: 'system',
            actorId: null,
            action: 'checklist_item_updated',
            entityType: 'intervention_checklist_item',
            entityId: id,
            metadata: { actorCognitoSub: request.jwt?.sub ?? null, changed: Object.keys(patch) },
            ipAddress: request.ip,
          },
        });

        return updated;
      });

      return reply.code(200).send({ checklistItem: serializeChecklistItemAdmin(row) });
    },
  );

  // ── DELETE /v1/admin/checklist-items/:id ──────────────────────────────────────
  app.delete(
    '/v1/admin/checklist-items/:id',
    { preHandler: [requireAuth, requirePlatformAdminsPool] },
    async (request, reply) => {
      const parsedParams = ItemParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        throw businessError('admin.checklist_item.not_found', 404, 'Voce checklist non trovata.');
      }
      const { id } = parsedParams.data;

      await app.withContext({ role: 'admin' as const }, async (tx) => {
        const existing = await tx.interventionChecklistItem.findFirst({
          where: { id },
          select: { id: true },
        });
        if (!existing) {
          throw businessError('admin.checklist_item.not_found', 404, 'Voce checklist non trovata.');
        }

        // Hard delete: onDelete: SetNull on InterventionChecklistSelection
        // preserves historical selections with label_snapshot intact
        // (BR-303/D8) — no P2003 concern here (see file header).
        await tx.interventionChecklistItem.delete({ where: { id } });

        await tx.auditLog.create({
          data: {
            tenantId: null,
            actorType: 'system',
            actorId: null,
            action: 'checklist_item_deleted',
            entityType: 'intervention_checklist_item',
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

export default adminChecklistItemsRoutes;
