// POST /v1/vehicles/:id/ownership-transfer — F-OFF-110 officina-mediated
// single-step vehicle transfer (BR-049, see spec
// docs/superpowers/specs/2026-05-21-f-off-110-officina-mediated-transfer-design.md).
//
// Auth chain: requireAuth → requireOfficinaPool → tenantContext
// Role: super_admin OR mechanic (both can execute transfers; mechanic
// is the common in-store actor).
// RLS context: role: 'admin' for writes (memory feedback_withcontext_empty_blocks_rls_writes).
//
// Error codes (see APPENDICE_G):
//   vehicle.transfer.role_denied              — 403
//   vehicle.not_found                         — 404
//   vehicle.transfer.pending_not_transferable — 422 BR-046
//   vehicle.transfer.archived                 — 422
//   vehicle.transfer.no_active_ownership      — 422
//   vehicle.transfer.active_transfer_exists   — 409 BR-047
//   vehicle.transfer.same_owner               — 409
//   vehicle.transfer.recipient_not_found      — 422

import { randomUUID } from 'node:crypto';

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { env } from '../../config/env.js';
import { businessError } from '../../lib/business-error.js';
import { dispatchNotification } from '../../lib/notifications/dispatcher.js';
import { performOwnershipTransfer } from '../../lib/ownership-transfer.js';
import {
  S3ObjectNotFoundError,
  S3UnavailableError,
  headObject,
  presignPutObject,
} from '../../lib/s3.js';
import { vehicleDetailSelect } from '../../lib/vehicle-shared.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

const ParamsSchema = z.object({ id: z.uuid() });

// F-OFF-110 PR-2 — libretto document upload. Single document, 10 MB cap,
// 4 formats (no webp — a libretto scan does not need it). Stored under
// the vehicle-transfers/ prefix on the shared attachments bucket.
const LIBRETTO_MIME_TYPES = ['image/jpeg', 'image/png', 'application/pdf', 'image/heic'] as const;
const LIBRETTO_MAX_SIZE_BYTES = 10 * 1024 * 1024;
const LIBRETTO_URL_EXPIRY_SECONDS = 900; // 15 min

const DocumentUrlBodySchema = z.object({
  fileName: z
    .string()
    .trim()
    .min(1)
    .max(255)
    // eslint-disable-next-line no-control-regex
    .refine((v) => !/[\x00-\x1F]/.test(v), 'control bytes not allowed'),
  mimeType: z.enum(LIBRETTO_MIME_TYPES),
  sizeBytes: z.number().int().positive().max(LIBRETTO_MAX_SIZE_BYTES),
});

function deriveLibrettoExtension(mimeType: (typeof LIBRETTO_MIME_TYPES)[number]): string {
  switch (mimeType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'application/pdf':
      return 'pdf';
    case 'image/heic':
      return 'heic';
  }
}

// Matches the suffix of a libretto key after the vehicle-transfers/<vehicleId>/
// prefix: a UUID + one of the 4 allowed extensions. Keeps a malicious client
// from passing an arbitrary or cross-vehicle S3 key into documentUrl.
const LIBRETTO_KEY_SUFFIX_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|pdf|heic)$/;

function isValidDocumentKey(key: string, vehicleId: string): boolean {
  const prefix = `vehicle-transfers/${vehicleId}/`;
  if (!key.startsWith(prefix)) return false;
  return LIBRETTO_KEY_SUFFIX_RE.test(key.slice(prefix.length));
}

const RecipientExistingSchema = z.object({
  kind: z.literal('existing'),
  customerId: z.uuid(),
});

const RecipientNewSchema = z.object({
  kind: z.literal('new'),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(255),
  phone: z.string().trim().max(30).nullable().optional(),
  codiceFiscale: z.string().trim().max(20).nullable().optional(),
  isBusiness: z.boolean().optional(),
  businessName: z.string().trim().max(200).nullable().optional(),
  vatNumber: z.string().trim().max(20).nullable().optional(),
});

const BodySchema = z
  .object({
    recipient: z.discriminatedUnion('kind', [RecipientExistingSchema, RecipientNewSchema]),
    reason: z.enum(['purchase', 'inheritance', 'company_assignment', 'other']),
    notes: z.string().trim().max(1000).nullable().optional(),
    documentS3Key: z.string().trim().max(500).nullable().optional(),
  })
  .refine(
    (b) => {
      if (b.recipient.kind === 'new' && b.recipient.isBusiness === true) {
        return Boolean(b.recipient.businessName && b.recipient.vatNumber);
      }
      return true;
    },
    {
      message: 'businessName and vatNumber required when isBusiness=true',
      path: ['recipient'],
    },
  );

// Both transfer endpoints are restricted to super_admin / mechanic
// (mechanic is the common in-store actor). Throws vehicle.transfer.role_denied.
function assertTransferRole(role: string | undefined): void {
  if (role !== 'super_admin' && role !== 'mechanic') {
    throw businessError(
      'vehicle.transfer.role_denied',
      403,
      'Ruolo non autorizzato per il trasferimento.',
    );
  }
}

export const vehiclesOwnershipTransferRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/v1/vehicles/:id/ownership-transfer',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request, reply) => {
      const parsedParams = ParamsSchema.safeParse(request.params);
      if (!parsedParams.success) throw parsedParams.error;
      const parsedBody = BodySchema.safeParse(request.body);
      if (!parsedBody.success) throw parsedBody.error;

      assertTransferRole(request.userRole);

      const tenantId = request.tenantId!;
      const cognitoSub = request.userId!;
      const vehicleId = parsedParams.data.id;
      const body = parsedBody.data;

      // Validate the optional libretto document BEFORE opening the
      // transaction — headObject is an external S3 call.
      let validatedDocumentKey: string | null = null;
      if (body.documentS3Key) {
        if (!isValidDocumentKey(body.documentS3Key, vehicleId)) {
          throw businessError(
            'vehicle.transfer.document_invalid',
            422,
            'Documento del libretto non valido.',
          );
        }
        let head: { contentLength: number; contentType: string };
        try {
          head = await headObject(env.S3_ATTACHMENTS_BUCKET, body.documentS3Key);
        } catch (err) {
          if (err instanceof S3ObjectNotFoundError) {
            throw businessError(
              'vehicle.transfer.document_invalid',
              422,
              'Documento del libretto non trovato su S3.',
            );
          }
          if (err instanceof S3UnavailableError) {
            throw businessError(
              'vehicle.transfer.document_s3_unavailable',
              502,
              'Servizio storage temporaneamente non disponibile.',
            );
          }
          throw err;
        }
        if (
          head.contentLength > LIBRETTO_MAX_SIZE_BYTES ||
          !(LIBRETTO_MIME_TYPES as readonly string[]).includes(head.contentType)
        ) {
          throw businessError(
            'vehicle.transfer.document_invalid',
            422,
            'Documento del libretto non conforme (dimensione o formato).',
          );
        }
        validatedDocumentKey = body.documentS3Key;
      }

      const result = await app.withContext({ role: 'admin' as const }, async (tx) => {
        // tenant-context middleware already validated the user exists+active+
        // same-tenant — refetch the DB id (required for AccessLog FK).
        // findFirstOrThrow throws P2025 → 500 if absent (treat as unexpected).
        const actor = await tx.user.findFirstOrThrow({
          where: { cognitoSub, tenantId, deletedAt: null },
          select: { id: true },
        });

        return performOwnershipTransfer(tx, {
          vehicleId,
          tenantId,
          actorUserId: actor.id,
          recipient: body.recipient,
          reason: body.reason,
          notes: body.notes ?? null,
          documentS3Key: validatedDocumentKey,
        });
      });

      const vehicle = await app.prisma.vehicle.findUniqueOrThrow({
        where: { id: vehicleId },
        select: vehicleDetailSelect,
      });

      // Best-effort cedente notification. dispatchNotification never
      // throws (documented contract) — a notification failure never
      // affects the already-committed transfer.
      if (result.previousOwner) {
        await dispatchNotification({
          event: {
            type: 'ownership.transferred',
            vehicle: { id: vehicleId, plate: result.vehiclePlate },
            tenant: result.tenant,
            transferReason: result.transfer.reason,
            transferredAt: result.transfer.completedAt.toISOString(),
          },
          recipient: result.previousOwner,
          logger: request.log,
        });
      }

      return reply.code(200).send({
        vehicle,
        ownership: {
          id: result.ownership.id,
          customerId: result.ownership.customerId,
          startedAt: result.ownership.startedAt.toISOString(),
        },
        transfer: {
          id: result.transfer.id,
          status: result.transfer.status,
          completedAt: result.transfer.completedAt.toISOString(),
          reason: result.transfer.reason,
          notes: result.transfer.notes,
        },
      });
    },
  );

  app.post(
    '/v1/vehicles/:id/ownership-transfer/document-upload-url',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request, reply) => {
      const parsedParams = ParamsSchema.safeParse(request.params);
      if (!parsedParams.success) throw parsedParams.error;
      const parsedBody = DocumentUrlBodySchema.safeParse(request.body);
      if (!parsedBody.success) throw parsedBody.error;

      assertTransferRole(request.userRole);

      const tenantId = request.tenantId!;
      const vehicleId = parsedParams.data.id;
      const body = parsedBody.data;

      // Tenant scoping: presign only for a vehicle the caller's tenant
      // created or certified (same predicate as performOwnershipTransfer
      // step 1). vehicles SELECT RLS is permissive, so this explicit
      // filter is the application-layer enforcement.
      const vehicle = await app.prisma.vehicle.findFirst({
        where: {
          id: vehicleId,
          OR: [{ certifiedByTenantId: tenantId }, { createdByTenantId: tenantId }],
        },
        select: { id: true },
      });
      if (!vehicle) {
        throw businessError('vehicle.not_found', 404, 'Veicolo non trovato.');
      }

      const documentId = randomUUID();
      const ext = deriveLibrettoExtension(body.mimeType);
      const s3Key = `vehicle-transfers/${vehicleId}/${documentId}.${ext}`;

      let uploadUrl: string;
      try {
        uploadUrl = await presignPutObject({
          bucket: env.S3_ATTACHMENTS_BUCKET,
          key: s3Key,
          contentType: body.mimeType,
          contentLength: body.sizeBytes,
          expiresInSeconds: LIBRETTO_URL_EXPIRY_SECONDS,
        });
      } catch (err) {
        if (err instanceof S3UnavailableError) {
          throw businessError(
            'vehicle.transfer.document_s3_unavailable',
            502,
            'Servizio storage temporaneamente non disponibile.',
          );
        }
        throw err;
      }

      const expiresAt = new Date(Date.now() + LIBRETTO_URL_EXPIRY_SECONDS * 1000).toISOString();

      return reply.code(200).send({
        uploadUrl,
        uploadMethod: 'PUT' as const,
        uploadHeaders: { 'Content-Type': body.mimeType },
        s3Key,
        expiresAt,
      });
    },
  );
};
