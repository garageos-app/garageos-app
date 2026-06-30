import { Prisma } from '@garageos/database';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import {
  decodeCursor,
  encodeCursor,
  encodeCompoundCursor,
  decodeDateCompoundCursor,
} from '../../lib/cursor.js';
import { businessError } from '../../lib/business-error.js';
import { serializeCustomerAccessLog } from '../../lib/customer-access-log.js';
import { clientiContext } from '../../middleware/clienti-context.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireClientiPool } from '../../middleware/require-clienti-pool.js';

// /v1/me/vehicles* — customer-app surface (APPENDICE_A §3.5,
// F-CLI-105 / F-CLI-106). Auth chain mirrors the officine routes but
// substitutes the clienti pool guard + clienti context: only the
// authenticated customer's own vehicles are reachable, where ownership
// is the single active row per BR-040 (`vehicle_ownerships.ended_at IS
// NULL`).
//
// No access_log writes here: BR-154 audit covers tenant-side reads
// (the access_logs table requires a non-NULL user_id pointing at
// `users`, which customers do not occupy). Customer-side access
// telemetry, if added, would land in a separate table and is not in
// PR 11 scope.

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
});

const idParamSchema = z.object({
  id: z.uuid(),
});

// Vehicle projection used by both endpoints. Mirrors the officine list
// shape (vehicles_search) minus the ownerships nesting — the customer
// IS the owner here, so currentOwnership is flattened to the single
// row's id + startedAt and the customer object is omitted.
const meVehicleListSelect = {
  id: true,
  garageCode: true,
  vin: true,
  plate: true,
  plateCountry: true,
  make: true,
  model: true,
  year: true,
  vehicleType: true,
  fuelType: true,
  status: true,
} as const;

const meVehicleDetailSelect = {
  id: true,
  garageCode: true,
  vin: true,
  plate: true,
  plateCountry: true,
  make: true,
  model: true,
  version: true,
  year: true,
  registrationDate: true,
  vehicleType: true,
  fuelType: true,
  engineDisplacement: true,
  powerKw: true,
  color: true,
  status: true,
  certifiedAt: true,
  createdAt: true,
} as const;

// BR-020 garage code format: GO-NNN-AAAA, digits 2-9, letters minus
// I/O/Q/S/U. Normalize (trim + uppercase) so QR/manual entry casing is
// tolerated, then validate. Malformed input fails here → 400.
const claimBodySchema = z.object({
  garageCode: z
    .string()
    .transform((s) => s.trim().toUpperCase())
    .pipe(z.string().regex(/^GO-[2-9]{3}-[A-HJ-NPRTV-Z]{4}$/, 'Codice GarageOS non valido')),
});

// Lookup projection: public display fields returned to the client, plus
// status + active ownership rows used only for the BR-042 decision.
const claimVehicleSelect = {
  id: true,
  garageCode: true,
  make: true,
  model: true,
  year: true,
  plate: true,
  status: true,
  ownerships: {
    where: { endedAt: null },
    select: { id: true, customerId: true, startedAt: true },
  },
} as const;

const meVehicleRoutes: FastifyPluginAsync = async (app) => {
  // GET /v1/me/vehicles — F-CLI-105.
  // Returns vehicles the authenticated customer currently owns
  // (BR-040: exactly one active ownership row per vehicle, partial
  // unique index uq_ownership_vehicle_active enforces it). Sold or
  // transferred vehicles, where ended_at IS NOT NULL, are filtered out
  // — the customer can no longer act on them.
  app.get(
    '/v1/me/vehicles',
    {
      preHandler: [requireAuth, requireClientiPool, clientiContext],
    },
    async (request) => {
      const { limit, cursor } = listQuerySchema.parse(request.query);
      const customerId = request.customerId!;

      // withContext sets app.current_customer so private_interventions /
      // push_tokens / dispute RLS policies are satisfied for any
      // follow-on read in the same handler. The vehicle and ownership
      // RLS policies are USING(true), so the listing itself does not
      // strictly require customer context — we set it for symmetry with
      // the officine pattern and to keep future extensions safe.
      return app.withContext({ customerId, role: 'user' }, async (tx) => {
        const cursorId = decodeCursor(cursor);
        const ownerships = await tx.vehicleOwnership.findMany({
          where: { customerId, endedAt: null },
          select: {
            id: true,
            startedAt: true,
            vehicle: { select: meVehicleListSelect },
          },
          orderBy: { id: 'asc' },
          take: limit + 1,
          ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
        });

        const hasMore = ownerships.length > limit;
        const page = hasMore ? ownerships.slice(0, limit) : ownerships;

        const data = page.map((o) => ({
          ...o.vehicle,
          currentOwnership: { id: o.id, startedAt: o.startedAt },
        }));

        const lastRow = page.at(-1);
        return {
          data,
          meta: {
            has_more: hasMore,
            ...(hasMore && lastRow ? { cursor: encodeCursor(lastRow.id) } : {}),
          },
        };
      });
    },
  );

  // GET /v1/me/vehicles/:id — F-CLI-106.
  // Returns the full technical scheda for a vehicle the authenticated
  // customer currently owns. Vehicles the customer never owned, or used
  // to own (ended_at NOT NULL), surface as 404 — same code as a missing
  // vehicle id. Returning 404 (not 403) avoids leaking the existence of
  // vehicles outside the customer's perimeter.
  app.get(
    '/v1/me/vehicles/:id',
    {
      preHandler: [requireAuth, requireClientiPool, clientiContext],
    },
    async (request) => {
      const { id: vehicleId } = idParamSchema.parse(request.params);
      const customerId = request.customerId!;

      return app.withContext({ customerId, role: 'user' }, async (tx) => {
        const ownership = await tx.vehicleOwnership.findFirst({
          where: { vehicleId, customerId, endedAt: null },
          select: {
            id: true,
            startedAt: true,
            vehicle: { select: meVehicleDetailSelect },
          },
        });
        if (!ownership) {
          throw businessError(
            'me.vehicle.not_found',
            404,
            'Veicolo non trovato o non più di tua proprietà.',
          );
        }

        return {
          vehicle: ownership.vehicle,
          currentOwnership: {
            id: ownership.id,
            startedAt: ownership.startedAt,
          },
        };
      });
    },
  );

  // GET /v1/me/vehicles/:id/access-log — F-CLI-304 / BR-155.
  // The owning customer's audit trail of accesses to their vehicle.
  //
  // access_logs carries only the generic tenant_isolation RLS policy
  // (is_admin_role() OR tenant_id = current_tenant_id()), which a
  // customer (no tenant_id, not admin) cannot satisfy — so the reads run
  // in admin context and the app-layer ownership gate below is the
  // security boundary (the #154 lesson: never rely on RLS alone for a
  // customer endpoint). All reads are explicitly scoped by the
  // authenticated customerId / the gated vehicleId; no unscoped query
  // runs under the elevated role.
  //
  // Only 'view' and intervention 'create' surface; vehicle registrations
  // log the dedicated 'vehicle_registered' action and are excluded.
  // BR-155 redaction (no ip/userAgent/internal ids) is enforced by the
  // serializer. Mirrors the /me/profile precedent (admin context, scoped
  // by id) from F-CLI-004.
  app.get(
    '/v1/me/vehicles/:id/access-log',
    {
      preHandler: [requireAuth, requireClientiPool, clientiContext],
    },
    async (request) => {
      const { id: vehicleId } = idParamSchema.parse(request.params);
      const { limit, cursor } = listQuerySchema.parse(request.query);
      const customerId = request.customerId!;

      return app.withContext({ role: 'admin' }, async (tx) => {
        const ownership = await tx.vehicleOwnership.findFirst({
          where: { vehicleId, customerId, endedAt: null },
          select: { id: true },
        });
        if (!ownership) {
          throw businessError(
            'me.vehicle.not_found',
            404,
            'Veicolo non trovato o non più di tua proprietà.',
          );
        }

        const cur = decodeDateCompoundCursor('at', cursor, 'timestamp');
        const rows = await tx.accessLog.findMany({
          where: {
            vehicleId,
            action: { in: ['view', 'create'] },
            ...(cur
              ? {
                  OR: [
                    { createdAt: { lt: new Date(cur.at) } },
                    { createdAt: new Date(cur.at), id: { lt: cur.id } },
                  ],
                }
              : {}),
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: limit + 1,
          select: {
            id: true,
            action: true,
            createdAt: true,
            tenant: { select: { id: true, businessName: true } },
            user: { select: { firstName: true, lastName: true } },
          },
        });

        const relations = await tx.customerTenantRelation.findMany({
          where: { customerId },
          select: { tenantId: true },
        });
        const relationTenantIds = new Set(relations.map((r) => r.tenantId));

        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        const data = serializeCustomerAccessLog(page, relationTenantIds);
        const last = page.at(-1);
        return {
          data,
          meta: {
            has_more: hasMore,
            ...(hasMore && last
              ? { cursor: encodeCompoundCursor('at', last.createdAt.toISOString(), last.id) }
              : {}),
          },
        };
      });
    },
  );

  // POST /v1/me/vehicles/claim — F-CLI-101/102/103 / BR-042.
  // The customer attaches a certified vehicle to their account by garage
  // code. Manual entry, QR scan and invite-link flows all converge here:
  // the client sends only the extracted code.
  //
  // Runs in role:'user': vehicles + vehicle_ownerships RLS are USING(true),
  // so the customer reads the vehicle and inserts the ownership without
  // elevation. The security boundary is the explicit status/ownership
  // check below plus the partial unique index uq_ownership_vehicle_active
  // (BR-040) — never RLS alone (the #154 lesson).
  app.post(
    '/v1/me/vehicles/claim',
    {
      preHandler: [requireAuth, requireClientiPool, clientiContext],
    },
    async (request) => {
      const { garageCode } = claimBodySchema.parse(request.body);
      const customerId = request.customerId!;

      return app.withContext({ customerId, role: 'user' }, async (tx) => {
        const vehicle = await tx.vehicle.findFirst({
          where: { garageCode },
          select: claimVehicleSelect,
        });
        if (!vehicle) {
          throw businessError(
            'me.vehicle.claim.code_not_found',
            404,
            'Nessun veicolo trovato per questo codice.',
          );
        }

        const { status, ownerships, ...vehiclePublic } = vehicle;

        if (status === 'pending') {
          throw businessError(
            'me.vehicle.claim.pending',
            422,
            'Veicolo non ancora certificato: non può essere agganciato.',
          );
        }
        if (status === 'archived') {
          throw businessError(
            'me.vehicle.claim.archived',
            422,
            'Veicolo archiviato: non può essere agganciato.',
          );
        }
        // status === 'certified' falls through.

        const active = ownerships[0] ?? null;
        if (!active) {
          try {
            const ownership = await tx.vehicleOwnership.create({
              data: { vehicleId: vehicle.id, customerId, startedAt: new Date() },
              select: { id: true, startedAt: true },
            });
            return { vehicle: vehiclePublic, ownership, status: 'claimed' as const };
          } catch (err) {
            // Concurrent claim won the active-ownership unique index
            // (uq_ownership_vehicle_active). Refetch and resolve.
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
              const raced = await tx.vehicleOwnership.findFirst({
                where: { vehicleId: vehicle.id, endedAt: null },
                select: { id: true, customerId: true, startedAt: true },
              });
              if (raced && raced.customerId === customerId) {
                return {
                  vehicle: vehiclePublic,
                  ownership: { id: raced.id, startedAt: raced.startedAt },
                  status: 'already_owned' as const,
                };
              }
              throw businessError(
                'me.vehicle.claim.owned_by_other',
                409,
                'Veicolo già associato a un altro account.',
              );
            }
            throw err;
          }
        }

        if (active.customerId === customerId) {
          // BR-042: already owned by the caller -> idempotent success.
          return {
            vehicle: vehiclePublic,
            ownership: { id: active.id, startedAt: active.startedAt },
            status: 'already_owned' as const,
          };
        }

        // Owned by a different customer -> the caller must use the
        // ownership-transfer flow, not claim.
        throw businessError(
          'me.vehicle.claim.owned_by_other',
          409,
          'Veicolo già associato a un altro account.',
        );
      });
    },
  );
};

export default meVehicleRoutes;
