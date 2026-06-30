// GET /v1/admin/audit-logs — Platform-admin global audit viewer.
//
// Returns audit_log rows cross-tenant, newest-first, with optional filters
// and keyset pagination. Auth: requireAuth → requirePlatformAdminsPool.
// No rate-limit (read-only forensic tool, low-volume usage by platform admins).
//
// Cursor precision note: the cursor carries millisecond-precision createdAt
// via toISOString(), while Postgres stores timestamptz at microsecond
// precision. Two rows created within the same millisecond but different
// microseconds may, at a page boundary, be ordered by µs in the DB but
// compared at ms in the cursor. For a forensic admin log with at most a
// handful of concurrent admins this is a negligible documented limitation.
// The id tiebreaker makes same-millisecond pages deterministic in the
// common case.
//
// Tenant resolution: no deletedAt filter — audit history outlives
// soft-deleted tenants. Rows whose tenantId matches no tenant row
// (hard-deleted tenant) surface with businessName: null (not a 500).

import type { Prisma } from '@garageos/database';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { businessError } from '../../lib/business-error.js';
import {
  AUDIT_LOG_SELECT,
  decodeAuditCursor,
  encodeAuditCursor,
  serializeAuditLogItem,
  type AuditLogPage,
} from '../../lib/dtos/audit-log.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requirePlatformAdminsPool } from '../../middleware/require-platform-admins-pool.js';

const QuerySchema = z.object({
  tenantId: z.union([z.literal('platform'), z.string().uuid()]).optional(),
  action: z.string().min(1).max(100).optional(),
  actorType: z.enum(['user', 'customer', 'system', 'admin']).optional(),
  from: z.string().datetime().optional(), // ISO 8601; createdAt >= from
  to: z.string().datetime().optional(), // ISO 8601; createdAt <= to
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const adminAuditLogsRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/admin/audit-logs',
    { preHandler: [requireAuth, requirePlatformAdminsPool] },
    async (request, reply) => {
      const parsed = QuerySchema.safeParse(request.query);
      if (!parsed.success) {
        throw businessError('VALIDATION_ERROR', 400, 'Parametri non validi.');
      }
      const { tenantId, action, actorType, from, to, cursor: rawCursor, limit } = parsed.data;

      // Cursor decode: absent rawCursor = first page (no cursor constraint).
      // A non-null rawCursor that fails decoding is a malformed token → 400.
      const cursor = rawCursor !== undefined ? decodeAuditCursor(rawCursor) : null;
      if (rawCursor !== undefined && cursor === null) {
        throw businessError('VALIDATION_ERROR', 400, 'Parametri non validi.');
      }

      const page = await app.withContext({ role: 'admin' as const }, async (tx) => {
        // Build filter predicates incrementally to avoid undefined values
        // in the object (exactOptionalPropertyTypes compliance).
        const filterWhere: Prisma.AuditLogWhereInput = {};
        if (tenantId === 'platform') {
          // 'platform' sentinel → WHERE tenant_id IS NULL.
          filterWhere.tenantId = null;
        } else if (tenantId !== undefined) {
          filterWhere.tenantId = tenantId;
        }
        if (action !== undefined) filterWhere.action = action;
        if (actorType !== undefined) filterWhere.actorType = actorType;
        if (from !== undefined || to !== undefined) {
          filterWhere.createdAt = {
            ...(from !== undefined ? { gte: new Date(from) } : {}),
            ...(to !== undefined ? { lte: new Date(to) } : {}),
          };
        }

        // Keyset cursor expansion: (createdAt DESC, id DESC) newest-first.
        // The OR-form correctly handles ties at millisecond boundaries via
        // the id tiebreaker. See header comment for precision note.
        const cursorWhere: Prisma.AuditLogWhereInput =
          cursor !== null
            ? {
                OR: [
                  { createdAt: { lt: new Date(cursor.createdAt) } },
                  { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
                ],
              }
            : {};

        const orderBy = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];

        // Fetch limit + 1 to detect a next page without an extra COUNT query.
        const rows = await tx.auditLog.findMany({
          where: { AND: [filterWhere, cursorWhere] },
          orderBy,
          take: limit + 1,
          select: AUDIT_LOG_SELECT,
        });

        const hasMore = rows.length > limit;
        const pageRows = hasMore ? rows.slice(0, limit) : rows;
        const nextCursor = hasMore ? encodeAuditCursor(pageRows[pageRows.length - 1]!) : null;

        // Batch-resolve tenant names — no N+1 query.
        // No deletedAt filter: audit history outlives soft-deleted tenants.
        // A tenantId that matches no tenant row (hard-deleted) yields
        // businessName: null via the serializer.
        const tenantIds = [
          ...new Set(pageRows.map((r) => r.tenantId).filter((x): x is string => x !== null)),
        ];
        const tenants =
          tenantIds.length > 0
            ? await tx.tenant.findMany({
                where: { id: { in: tenantIds } },
                select: { id: true, businessName: true },
              })
            : [];
        const nameById = new Map(tenants.map((t) => [t.id, t.businessName] as const));
        const items = pageRows.map((r) => serializeAuditLogItem(r, nameById));

        return { items, nextCursor } satisfies AuditLogPage;
      });

      return reply.code(200).send(page);
    },
  );
};
