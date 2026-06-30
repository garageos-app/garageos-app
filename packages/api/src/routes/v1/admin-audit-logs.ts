// GET /v1/admin/audit-logs — Platform-admin global audit viewer.
//
// Returns audit_log rows cross-tenant, newest-first, with optional filters
// and keyset pagination. Auth: requireAuth → requirePlatformAdminsPool.
// No rate-limit (read-only forensic tool, low-volume usage by platform admins).
//
// Cursor precision: the LIST query runs as parameterized raw SQL so the
// cursor carries a MICROSECOND-precision createdAt (formatted by to_char with
// the 'US' pattern) and the keyset comparison is a full-precision row-value
// `(created_at, id) < (cursor.createdAt::timestamptz, cursor.id)`. This avoids
// silently skipping rows that share a boundary millisecond but differ in
// microseconds (rows written in one transaction share an identical µs
// timestamp). The global (created_at DESC, id DESC) index supports the
// no-tenant-filter ordering. Every placeholder carries an explicit `::` cast
// because the Prisma 7 pg adapter's type inference otherwise fails (42P08).
//
// Tenant resolution: no deletedAt filter — audit history outlives
// soft-deleted tenants. Rows whose tenantId matches no tenant row
// (hard-deleted tenant) surface with businessName: null (not a 500).

import type { Prisma } from '@garageos/database';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { businessError } from '../../lib/business-error.js';
import {
  decodeAuditCursor,
  encodeAuditCursor,
  serializeAuditLogItem,
  type AuditLogPage,
  type AuditLogRow,
} from '../../lib/dtos/audit-log.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requirePlatformAdminsPool } from '../../middleware/require-platform-admins-pool.js';

// Raw row shape returned by the parameterized LIST query. snake_case mirrors
// the selected columns exactly; created_at_cursor is the microsecond-precision
// ISO string used to build the keyset cursor.
interface RawAuditRow {
  id: string;
  tenant_id: string | null;
  actor_type: 'user' | 'customer' | 'system' | 'admin';
  actor_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  ip_address: string | null;
  // Json column returned already parsed by the pg adapter; typed as JsonValue
  // (not unknown) so it maps cleanly into AuditLogRow without a cast.
  metadata: Prisma.JsonValue;
  created_at: Date;
  created_at_cursor: string;
}

const QuerySchema = z
  .object({
    tenantId: z.union([z.literal('platform'), z.string().uuid()]).optional(),
    action: z.string().min(1).max(100).optional(),
    actorType: z.enum(['user', 'customer', 'system', 'admin']).optional(),
    from: z.string().datetime().optional(), // ISO 8601; createdAt >= from
    to: z.string().datetime().optional(), // ISO 8601; createdAt <= to
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  // An inverted range (from > to) is a client error, not an empty result set.
  .refine((q) => !q.from || !q.to || new Date(q.from) <= new Date(q.to), {
    message: 'from must be <= to',
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
        // Build the LIST query as parameterized raw SQL. Every value is bound
        // (no string interpolation of user input) and every placeholder carries
        // an explicit `::` cast — the Prisma 7 pg adapter's type inference
        // otherwise fails with 42P08 (see feedback_pg_param_type_inference_cast).
        const conditions: string[] = [];
        const params: unknown[] = [];
        let p = 0;
        if (tenantId === 'platform') {
          // 'platform' sentinel → WHERE tenant_id IS NULL.
          conditions.push('tenant_id IS NULL');
        } else if (tenantId !== undefined) {
          params.push(tenantId);
          conditions.push(`tenant_id = $${++p}::uuid`);
        }
        if (action !== undefined) {
          params.push(action);
          conditions.push(`action = $${++p}::text`);
        }
        if (actorType !== undefined) {
          params.push(actorType);
          conditions.push(`actor_type = $${++p}::"AuditActorType"`);
        }
        if (from !== undefined) {
          params.push(from);
          conditions.push(`created_at >= $${++p}::timestamptz`);
        }
        if (to !== undefined) {
          params.push(to);
          conditions.push(`created_at <= $${++p}::timestamptz`);
        }
        if (cursor !== null) {
          // Full-precision keyset comparison: newest-first (created_at DESC,
          // id DESC) means "older than the cursor" is a row-value `<`.
          params.push(cursor.createdAt);
          const a = ++p;
          params.push(cursor.id);
          const b = ++p;
          conditions.push(`(created_at, id) < ($${a}::timestamptz, $${b}::uuid)`);
        }
        const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        // Fetch limit + 1 to detect a next page without an extra COUNT query.
        params.push(limit + 1);
        const limitParam = p + 1; // last placeholder; p is not reused after this

        // created_at_cursor: canonical UTC ISO with MICROSECOND precision. It
        // casts back to the same instant via ::timestamptz on the next page.
        const sql = `
          SELECT id, tenant_id, actor_type, actor_id, action, entity_type, entity_id,
                 ip_address::text AS ip_address, metadata, created_at,
                 to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor
          FROM audit_logs
          ${whereSql}
          ORDER BY created_at DESC, id DESC
          LIMIT $${limitParam}::int
        `;
        const rawRows = await tx.$queryRawUnsafe<RawAuditRow[]>(sql, ...params);

        const hasMore = rawRows.length > limit;
        const pageRaw = hasMore ? rawRows.slice(0, limit) : rawRows;

        // Map snake_case raw rows to the camelCase shape the serializer expects.
        const pageRows: AuditLogRow[] = pageRaw.map((r) => ({
          id: r.id,
          tenantId: r.tenant_id,
          actorType: r.actor_type,
          actorId: r.actor_id,
          action: r.action,
          entityType: r.entity_type,
          entityId: r.entity_id,
          ipAddress: r.ip_address,
          metadata: r.metadata,
          createdAt: r.created_at,
        }));

        const last = pageRaw[pageRaw.length - 1];
        const nextCursor =
          hasMore && last !== undefined
            ? encodeAuditCursor({ createdAt: last.created_at_cursor, id: last.id })
            : null;

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
