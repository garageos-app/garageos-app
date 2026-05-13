import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { env } from '../../config/env.js';
import { businessError } from '../../lib/business-error.js';
import {
  S3ObjectNotFoundError,
  S3UnavailableError,
  headObject,
  presignGetObject,
  presignPutObject,
} from '../../lib/s3.js';
import { dualPoolContext } from '../../middleware/dual-pool-context.js';
import { requireAuth } from '../../middleware/require-auth.js';

// POST /v1/attachments/upload-url (F-OFF-305, phase 1 of 2)
// Supports two pools:
//   officine — owner_type 'intervention' (tenant-scoped) or
//              'intervention_dispute' (open-dispute attachment by staff)
//   clienti  — owner_type 'intervention_dispute' (customer uploads
//              evidence against their own vehicle's intervention)
//
// POST /v1/attachments/:id/confirm (F-OFF-305, phase 2 of 2)
// Cross-pool: both officine and clienti users may confirm their own upload.
//
// See APPENDICE_A §attachments, APPENDICE_F BR-300/301 (if assigned).

const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
] as const;

const MAX_SIZE_BYTES = 26_214_400; // 25 MB
const PRESIGNED_URL_EXPIRY_SECONDS = 900; // 15 min

const UploadUrlSchema = z.object({
  owner_type: z.enum(['intervention', 'private_intervention', 'intervention_dispute']),
  owner_id: z.string().uuid(),
  file_name: z
    .string()
    .min(1)
    .max(255)
    // eslint-disable-next-line no-control-regex
    .refine((v) => !/[\x00-\x1F]/.test(v), 'control bytes not allowed'),
  mime_type: z.enum(ALLOWED_MIME_TYPES),
  size_bytes: z.number().int().positive().max(MAX_SIZE_BYTES),
});

function deriveExtension(mimeType: string): string {
  switch (mimeType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/heic':
      return 'heic';
    case 'application/pdf':
      return 'pdf';
    default:
      throw new Error(`Unreachable: unsupported mime ${mimeType}`);
  }
}

const ConfirmParamsSchema = z.object({
  id: z.string().uuid(),
});

// AttachmentOwnerType values from the Prisma-generated enum.
// The type is not re-exported from @garageos/database so we declare
// it locally as a string union matching the DB enum exactly.
type AttachmentOwnerType = 'intervention' | 'private_intervention' | 'intervention_dispute';

// AttachmentRowForConfirm is the full attachment row shape expected by
// executeConfirmFlow and serializeAttachment. Both confirm branches share
// this type so the inline anonymous types don't need to be repeated.
type AttachmentRowForConfirm = {
  id: string;
  ownerType: AttachmentOwnerType;
  ownerId: string;
  tenantId: string | null;
  uploadedByCustomerId: string | null;
  uploadedByUserId: string | null;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  s3Key: string;
  s3Bucket: string;
  processed: boolean;
  createdAt: Date;
};

interface AttachmentTxWithUpdate {
  attachment: {
    update: (args: {
      where: { id: string };
      data: { processed: true };
    }) => Promise<AttachmentRowForConfirm>;
  };
}

// serializeAttachment converts a DB attachment row to the snake_case
// JSON wire format (see APPENDICE_A §attachments). Used in confirm responses.
function serializeAttachment(attachment: {
  id: string;
  ownerType: AttachmentOwnerType;
  ownerId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  processed: boolean;
  createdAt: Date;
}) {
  return {
    id: attachment.id,
    owner_type: attachment.ownerType,
    owner_id: attachment.ownerId,
    file_name: attachment.fileName,
    mime_type: attachment.mimeType,
    size_bytes: attachment.sizeBytes,
    processed: attachment.processed,
    uploaded_at: attachment.createdAt.toISOString(),
  };
}

// presignViewUrl produces a short-lived presigned GET URL + ISO8601 expiry
// for an already-confirmed attachment. Shared between the officina and
// clienti branches of the view-url handler. Maps S3UnavailableError to a
// 502 business error; other errors bubble to the default 500 handler.
async function presignViewUrl(
  bucket: string,
  key: string,
): Promise<{ url: string; expires_at: string }> {
  let url: string;
  try {
    url = await presignGetObject({
      bucket,
      key,
      expiresInSeconds: PRESIGNED_URL_EXPIRY_SECONDS,
    });
  } catch (err) {
    if (err instanceof S3UnavailableError) {
      throw businessError(
        'attachment.view_url.s3_unavailable',
        502,
        'Servizio storage temporaneamente non disponibile.',
      );
    }
    throw err;
  }
  const expiresAt = new Date(Date.now() + PRESIGNED_URL_EXPIRY_SECONDS * 1000).toISOString();
  return { url, expires_at: expiresAt };
}

// isP2025 checks whether an unknown error is a Prisma P2025 (record not found).
// Used across all handlers to distinguish "missing record" from other DB errors,
// which should still bubble up as 500.
function isP2025(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'P2025'
  );
}

// buildPresignedPayload constructs the presigned URL response object shared
// across all upload handlers.
async function buildPresignedPayload(
  mimeType: string,
  sizeBytes: number,
  attachmentId: string,
  s3Key: string,
): Promise<{
  attachment_id: string;
  upload_url: string;
  upload_method: 'PUT';
  upload_headers: { 'Content-Type': string };
  expires_at: string;
  callback_url: string;
}> {
  const bucket = env.S3_ATTACHMENTS_BUCKET;

  let uploadUrl: string;
  try {
    uploadUrl = await presignPutObject({
      bucket,
      key: s3Key,
      contentType: mimeType,
      contentLength: sizeBytes,
      expiresInSeconds: PRESIGNED_URL_EXPIRY_SECONDS,
    });
  } catch (err) {
    if (err instanceof S3UnavailableError) {
      throw businessError(
        'attachment.upload.s3_unavailable',
        502,
        'Servizio storage temporaneamente non disponibile.',
      );
    }
    throw err;
  }

  const expiresAt = new Date(Date.now() + PRESIGNED_URL_EXPIRY_SECONDS * 1000).toISOString();

  return {
    attachment_id: attachmentId,
    upload_url: uploadUrl,
    upload_method: 'PUT',
    upload_headers: { 'Content-Type': mimeType },
    expires_at: expiresAt,
    callback_url: `/v1/attachments/${attachmentId}/confirm`,
  };
}

// Common idempotent flow: HeadObject verify + flip processed:true.
// Both pool branches share this logic; only the lookup + uploader auth differ.
async function executeConfirmFlow(
  tx: AttachmentTxWithUpdate,
  attachment: AttachmentRowForConfirm,
): Promise<ReturnType<typeof serializeAttachment>> {
  if (attachment.processed) {
    return serializeAttachment(attachment);
  }

  let head: { contentLength: number; contentType: string };
  try {
    head = await headObject(attachment.s3Bucket, attachment.s3Key);
  } catch (err) {
    if (err instanceof S3ObjectNotFoundError) {
      throw businessError(
        'attachment.confirm.upload_not_found',
        422,
        "File non trovato su S3 — l'upload non è atterrato o è scaduto.",
      );
    }
    if (err instanceof S3UnavailableError) {
      throw businessError(
        'attachment.confirm.s3_unavailable',
        502,
        'Servizio storage temporaneamente non disponibile.',
      );
    }
    throw err;
  }

  if (head.contentLength !== attachment.sizeBytes || head.contentType !== attachment.mimeType) {
    throw businessError(
      'attachment.confirm.metadata_mismatch',
      422,
      `S3 metadata non matcha: size ${head.contentLength}/${attachment.sizeBytes}, type ${head.contentType}/${attachment.mimeType}.`,
    );
  }

  const updated = await tx.attachment.update({
    where: { id: attachment.id },
    data: { processed: true },
  });

  return serializeAttachment(updated);
}

// handleInterventionUpload handles the existing officine-only flow for
// owner_type='intervention'. Extracted from the original handler to keep
// the main dispatch function readable.
async function handleInterventionUpload(
  app: FastifyInstance,
  request: FastifyRequest,
  body: z.infer<typeof UploadUrlSchema>,
): Promise<ReturnType<typeof buildPresignedPayload>> {
  const tenantId = request.tenantId!;
  const cognitoSub = request.userId!;

  return app.withContext({ tenantId }, async (tx) => {
    // Defense-in-depth post-PR #27 RLS split: bind user lookup to
    // (cognitoSub, tenantId) to prevent cross-tenant JWT attacks.
    const user = await tx.user.findFirstOrThrow({
      where: { cognitoSub, tenantId },
      select: { id: true },
    });

    // Ownership check: ensure the intervention belongs to this tenant.
    // P2025 (record not found) from RLS or genuinely missing → 404.
    // Only P2025 is caught; other errors bubble to the default handler
    // as 500 rather than being silently masked as 404.
    try {
      await tx.intervention.findFirstOrThrow({
        where: { id: body.owner_id, tenantId },
        select: { id: true },
      });
    } catch (err) {
      if (isP2025(err)) {
        throw businessError(
          'attachment.upload.intervention_not_found',
          404,
          `Intervention ${body.owner_id} non trovato o non appartiene al tuo tenant.`,
        );
      }
      throw err;
    }

    const attachmentId = randomUUID();
    const ext = deriveExtension(body.mime_type);
    // s3Key format: 'attachments/<owner_type>/<owner_id>/<uuid>.<ext>'
    // Static prefix prevents path traversal; uuid prevents enumeration.
    const s3Key = `attachments/${body.owner_type}/${body.owner_id}/${attachmentId}.${ext}`;
    const bucket = env.S3_ATTACHMENTS_BUCKET;

    await tx.attachment.create({
      data: {
        id: attachmentId,
        ownerType: body.owner_type as AttachmentOwnerType,
        ownerId: body.owner_id,
        tenantId,
        uploadedByUserId: user.id,
        fileName: body.file_name,
        mimeType: body.mime_type,
        sizeBytes: body.size_bytes,
        s3Key,
        s3Bucket: bucket,
        processed: false,
      },
    });

    return buildPresignedPayload(body.mime_type, body.size_bytes, attachmentId, s3Key);
  });
}

// handleDisputeUploadCustomer handles owner_type='intervention_dispute' for
// clienti-pool users. The customer must own the vehicle linked to the
// intervention (BR-151 ownership check) before uploading dispute evidence.
async function handleDisputeUploadCustomer(
  app: FastifyInstance,
  request: FastifyRequest,
  body: z.infer<typeof UploadUrlSchema>,
): Promise<ReturnType<typeof buildPresignedPayload>> {
  const customerId = request.customerId!;

  return app.withContext({ customerId }, async (tx) => {
    // Resolve the intervention to get tenantId and vehicleId.
    // Use findUniqueOrThrow (by primary key) — no tenant filter needed
    // because the vehicle-ownership check below scopes access.
    let intervention: { id: string; tenantId: string; vehicleId: string };
    try {
      intervention = await tx.intervention.findUniqueOrThrow({
        where: { id: body.owner_id },
        select: { id: true, tenantId: true, vehicleId: true },
      });
    } catch (err) {
      if (isP2025(err)) {
        throw businessError(
          'attachment.upload.intervention_not_found',
          404,
          `Intervention ${body.owner_id} non trovato.`,
        );
      }
      throw err;
    }

    // BR-151: customer must have an active ownership of the vehicle
    // linked to the intervention.
    const ownership = await tx.vehicleOwnership.findFirst({
      where: { vehicleId: intervention.vehicleId, customerId, endedAt: null },
      select: { id: true },
    });
    if (!ownership) {
      throw businessError(
        'attachment.upload.intervention_dispute_not_owner',
        403,
        'Il cliente non è proprietario del veicolo associato a questo intervento.',
      );
    }

    const attachmentId = randomUUID();
    const ext = deriveExtension(body.mime_type);
    const s3Key = `attachments/${body.owner_type}/${body.owner_id}/${attachmentId}.${ext}`;
    const bucket = env.S3_ATTACHMENTS_BUCKET;

    await tx.attachment.create({
      data: {
        id: attachmentId,
        ownerType: 'intervention_dispute',
        ownerId: body.owner_id,
        tenantId: intervention.tenantId,
        customerId,
        uploadedByCustomerId: customerId,
        fileName: body.file_name,
        mimeType: body.mime_type,
        sizeBytes: body.size_bytes,
        s3Key,
        s3Bucket: bucket,
        processed: false,
      },
    });

    return buildPresignedPayload(body.mime_type, body.size_bytes, attachmentId, s3Key);
  });
}

// handleDisputeUploadOfficina handles owner_type='intervention_dispute' for
// officine-pool users. Staff must have role super_admin or mechanic, and the
// intervention must have an open dispute.
async function handleDisputeUploadOfficina(
  app: FastifyInstance,
  request: FastifyRequest,
  body: z.infer<typeof UploadUrlSchema>,
): Promise<ReturnType<typeof buildPresignedPayload>> {
  const tenantId = request.tenantId!;
  const cognitoSub = request.userId!;

  return app.withContext({ tenantId }, async (tx) => {
    // Defense-in-depth post-PR #27 RLS split: bind user lookup to
    // (cognitoSub, tenantId) to prevent cross-tenant JWT attacks.
    const user = await tx.user.findFirstOrThrow({
      where: { cognitoSub, tenantId },
      select: { id: true, role: true },
    });

    // Only super_admin and mechanic may upload dispute attachments.
    const allowedRoles = ['super_admin', 'mechanic'] as const;
    // user.role is typed as string from the select; the cast is safe because
    // includes() returns false for any value outside the tuple — no runtime
    // risk, just appeases TS narrowing.
    if (!allowedRoles.includes(user.role as (typeof allowedRoles)[number])) {
      throw businessError(
        'attachment.upload.intervention_dispute_role_denied',
        403,
        'Solo super_admin e mechanic possono caricare allegati per dispute.',
      );
    }

    // Ownership check: intervention must belong to this tenant.
    try {
      await tx.intervention.findFirstOrThrow({
        where: { id: body.owner_id, tenantId },
      });
    } catch (err) {
      if (isP2025(err)) {
        throw businessError(
          'attachment.upload.intervention_not_found',
          404,
          `Intervention ${body.owner_id} non trovato o non appartiene al tuo tenant.`,
        );
      }
      throw err;
    }

    // A dispute must be open to accept new attachments.
    const dispute = await tx.interventionDispute.findFirst({
      where: { interventionId: body.owner_id, status: 'open' },
      select: { id: true },
    });
    if (!dispute) {
      throw businessError(
        'attachment.upload.no_open_dispute',
        422,
        `Nessuna disputa aperta per l'intervento ${body.owner_id}.`,
      );
    }

    const attachmentId = randomUUID();
    const ext = deriveExtension(body.mime_type);
    const s3Key = `attachments/${body.owner_type}/${body.owner_id}/${attachmentId}.${ext}`;
    const bucket = env.S3_ATTACHMENTS_BUCKET;

    await tx.attachment.create({
      data: {
        id: attachmentId,
        ownerType: 'intervention_dispute',
        ownerId: body.owner_id,
        tenantId,
        customerId: null,
        uploadedByUserId: user.id,
        uploadedByCustomerId: null,
        fileName: body.file_name,
        mimeType: body.mime_type,
        sizeBytes: body.size_bytes,
        s3Key,
        s3Bucket: bucket,
        processed: false,
      },
    });

    return buildPresignedPayload(body.mime_type, body.size_bytes, attachmentId, s3Key);
  });
}

// handlePrivateInterventionUpload handles owner_type='private_intervention'
// for clienti-pool users. F-OFF-305 reciprocal: customer attaches photos /
// PDFs to their own private intervention. The XOR shape enforced by
// chk_attachment_owner_consistent requires tenant_id NULL + customer_id SET.
async function handlePrivateInterventionUpload(
  app: FastifyInstance,
  request: FastifyRequest,
  body: z.infer<typeof UploadUrlSchema>,
): Promise<ReturnType<typeof buildPresignedPayload>> {
  const customerId = request.customerId!;

  return app.withContext({ customerId }, async (tx) => {
    // Verify the private intervention exists, belongs to this customer,
    // and is not soft-deleted. RLS scopes by customerId; application-layer
    // defense-in-depth re-checks (lesson feedback_rls_split_lookup_auth_table).
    const privateInt = await tx.privateIntervention.findFirst({
      where: { id: body.owner_id, customerId, deletedAt: null },
      select: { id: true },
    });
    if (!privateInt) {
      throw businessError(
        'attachment.upload.private_intervention_not_found',
        404,
        `Intervento privato ${body.owner_id} non trovato.`,
      );
    }

    const attachmentId = randomUUID();
    const ext = deriveExtension(body.mime_type);
    const s3Key = `attachments/${body.owner_type}/${body.owner_id}/${attachmentId}.${ext}`;
    const bucket = env.S3_ATTACHMENTS_BUCKET;

    await tx.attachment.create({
      data: {
        id: attachmentId,
        ownerType: 'private_intervention',
        ownerId: body.owner_id,
        tenantId: null,
        customerId,
        uploadedByUserId: null,
        uploadedByCustomerId: customerId,
        fileName: body.file_name,
        mimeType: body.mime_type,
        sizeBytes: body.size_bytes,
        s3Key,
        s3Bucket: bucket,
        processed: false,
      },
    });

    return buildPresignedPayload(body.mime_type, body.size_bytes, attachmentId, s3Key);
  });
}

const attachmentsRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/v1/attachments/upload-url',
    {
      preHandler: [requireAuth, dualPoolContext],
    },
    async (request, reply) => {
      const body = UploadUrlSchema.parse(request.body);

      // Dispatch to the appropriate handler based on owner_type and pool.
      // Capture the response payload AFTER withContext resolves (i.e. after
      // Prisma COMMIT). Calling reply.send() inside the callback would cause
      // inject() to resolve before COMMIT, making DB assertions in tests see
      // pre-commit state. All other route handlers follow this same pattern.
      let result: Awaited<ReturnType<typeof buildPresignedPayload>>;

      if (body.owner_type === 'intervention_dispute') {
        if (request.authPool === 'clienti') {
          result = await handleDisputeUploadCustomer(app, request, body);
        } else if (request.authPool === 'officine') {
          result = await handleDisputeUploadOfficina(app, request, body);
        } else {
          throw businessError('auth.pool_mismatch', 403, 'Pool di autenticazione non supportato.');
        }
      } else if (body.owner_type === 'private_intervention') {
        // F-OFF-305 reciprocal: clienti-pool only.
        if (request.authPool !== 'clienti') {
          throw businessError(
            'attachment.upload.officina_pool_not_allowed_for_private',
            403,
            'Officina pool non può caricare allegati a interventi privati customer-side.',
          );
        }
        result = await handlePrivateInterventionUpload(app, request, body);
      } else {
        // owner_type === 'intervention'
        if (request.authPool !== 'officine') {
          throw businessError(
            'attachment.upload.officina_only',
            403,
            'Il caricamento di allegati per interventi richiede autenticazione officina.',
          );
        }
        result = await handleInterventionUpload(app, request, body);
      }

      return reply.code(201).send(result);
    },
  );

  // POST /v1/attachments/:id/confirm (F-OFF-305, phase 2 of 2)
  // Cross-pool: both officine and clienti users may confirm their own upload.
  // The server performs a HeadObject to verify ContentLength + ContentType
  // match the attachment row, then flips processed: false → true.
  // Idempotent: re-calling on an already-processed attachment returns 200
  // without re-calling S3. Only the original uploader may confirm.
  app.post(
    '/v1/attachments/:id/confirm',
    {
      preHandler: [requireAuth, dualPoolContext],
    },
    async (request, reply) => {
      const { id } = ConfirmParamsSchema.parse(request.params);

      // Capture the response payload AFTER withContext resolves (i.e. after
      // Prisma COMMIT). Calling reply.send() inside the callback would cause
      // inject() to resolve before COMMIT, making DB assertions in tests see
      // pre-commit state. All other route handlers follow this same pattern.
      let result: ReturnType<typeof serializeAttachment>;

      if (request.authPool === 'clienti') {
        const customerId = request.customerId!;

        result = await app.withContext({ customerId }, async (tx) => {
          // Lookup attachment by id only (no tenant filter for clienti).
          // RLS policy on attachments ensures only rows belonging to the
          // customer's context are visible.
          let attachment: AttachmentRowForConfirm;
          try {
            attachment = await tx.attachment.findFirstOrThrow({
              where: { id },
            });
          } catch (err) {
            if (isP2025(err)) {
              throw businessError(
                'attachment.confirm.not_found',
                404,
                `Attachment ${id} non trovato.`,
              );
            }
            throw err;
          }

          // Only the customer who requested the upload-url may confirm.
          if (attachment.uploadedByCustomerId !== customerId) {
            throw businessError(
              'attachment.confirm.not_uploader',
              403,
              'Solo chi ha richiesto upload-url può confermare.',
            );
          }

          return executeConfirmFlow(tx, attachment);
        });
      } else {
        // officine pool
        const tenantId = request.tenantId!;
        const cognitoSub = request.userId!;

        result = await app.withContext({ tenantId }, async (tx) => {
          // Defense-in-depth post-PR #27 RLS split: bind user lookup to
          // (cognitoSub, tenantId) to prevent cross-tenant JWT attacks.
          const user = await tx.user.findFirstOrThrow({
            where: { cognitoSub, tenantId },
            select: { id: true },
          });

          // Ownership check: ensure the attachment belongs to this tenant.
          // P2025 (record not found) from RLS or genuinely missing → 404.
          // Only P2025 is caught; other errors bubble to the default handler
          // as 500 rather than being silently masked as 404.
          let attachment: AttachmentRowForConfirm;
          try {
            attachment = await tx.attachment.findFirstOrThrow({
              where: { id, tenantId },
            });
          } catch (err) {
            if (isP2025(err)) {
              throw businessError(
                'attachment.confirm.not_found',
                404,
                `Attachment ${id} non trovato.`,
              );
            }
            throw err;
          }

          // Only the original uploader may confirm the upload.
          if (attachment.uploadedByUserId !== user.id) {
            throw businessError(
              'attachment.confirm.not_uploader',
              403,
              'Solo chi ha richiesto upload-url può confermare.',
            );
          }

          return executeConfirmFlow(tx, attachment);
        });
      }

      return reply.code(200).send(result);
    },
  );

  // GET /v1/attachments/:id/view-url — dualPool lazy presigned GET URL.
  // F-OFF-301 (officina detail page) + F-OFF-305 reciprocal (customer-side
  // private intervention attachments). Dispatch by (pool, ownerType):
  //   officine + intervention            → existing flow
  //   clienti  + private_intervention    → new in F2
  // Other combinations rejected with 422 attachment.owner_not_supported.
  // intervention_dispute view for clienti is deferred to a later UI slice.
  //
  // attachments_read RLS is permissive cross-tenant (same topology as
  // interventions_read), so the explicit tenantId/customerId filter is the
  // application-layer enforcement.
  const ViewUrlParamsSchema = z.object({ id: z.string().uuid() });
  app.get(
    '/v1/attachments/:id/view-url',
    {
      preHandler: [requireAuth, dualPoolContext],
    },
    async (request) => {
      const { id } = ViewUrlParamsSchema.parse(request.params);

      if (request.authPool === 'officine') {
        const tenantId = request.tenantId!;
        return app.withContext({ tenantId, role: 'user' as const }, async (tx) => {
          const att = await tx.attachment.findFirst({
            where: { id, tenantId, processed: true, deletedAt: null },
            select: { id: true, s3Key: true, s3Bucket: true, ownerType: true },
          });
          if (!att) {
            throw businessError('attachment.not_found', 404, 'Allegato non trovato.');
          }
          if (att.ownerType !== 'intervention') {
            throw businessError(
              'attachment.owner_not_supported',
              422,
              'Tipo di allegato non supportato per la visualizzazione.',
            );
          }
          return presignViewUrl(att.s3Bucket, att.s3Key);
        });
      }

      // clienti pool
      const customerId = request.customerId!;
      return app.withContext({ customerId, role: 'user' as const }, async (tx) => {
        const att = await tx.attachment.findFirst({
          where: { id, customerId, processed: true, deletedAt: null },
          select: { id: true, s3Key: true, s3Bucket: true, ownerType: true },
        });
        if (!att) {
          throw businessError('attachment.not_found', 404, 'Allegato non trovato.');
        }
        if (att.ownerType !== 'private_intervention') {
          throw businessError(
            'attachment.owner_not_supported',
            422,
            'Tipo di allegato non supportato per la visualizzazione.',
          );
        }
        return presignViewUrl(att.s3Bucket, att.s3Key);
      });
    },
  );
};

export default attachmentsRoutes;
