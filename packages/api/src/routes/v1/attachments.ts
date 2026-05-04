import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { env } from '../../config/env.js';
import { businessError } from '../../lib/business-error.js';
import {
  S3ObjectNotFoundError,
  S3UnavailableError,
  headObject,
  presignPutObject,
} from '../../lib/s3.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

// POST /v1/attachments/upload-url (F-OFF-305, phase 1 of 2)
// Officina requests a presigned S3 PUT URL. The attachment row is
// inserted with processed: false; the callback (POST /confirm, phase 2)
// flips the flag once the upload is verified.
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
  owner_type: z.enum(['intervention', 'private_intervention']),
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
type AttachmentOwnerType = 'intervention' | 'private_intervention';

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

const attachmentsRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/v1/attachments/upload-url',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request, reply) => {
      const body = UploadUrlSchema.parse(request.body);

      // BR-F-OFF-305: customer-side private interventions not supported in v1.
      // The owner_type enum accepts the value so validation passes, but we
      // reject it here with a descriptive 422 rather than silently ignoring it.
      if (body.owner_type === 'private_intervention') {
        throw businessError(
          'attachment.upload.private_intervention_not_supported',
          422,
          'Customer-side private interventions non ancora supportato in v1.',
        );
      }

      const tenantId = request.tenantId!;
      const cognitoSub = request.userId!;

      // Capture the response payload AFTER withContext resolves (i.e. after
      // Prisma COMMIT). Calling reply.send() inside the callback would cause
      // inject() to resolve before COMMIT, making DB assertions in tests see
      // pre-commit state. All other route handlers follow this same pattern.
      const result = await app.withContext({ tenantId }, async (tx) => {
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
          if (
            typeof err === 'object' &&
            err !== null &&
            'code' in err &&
            (err as { code: unknown }).code === 'P2025'
          ) {
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

        let uploadUrl: string;
        try {
          uploadUrl = await presignPutObject({
            bucket,
            key: s3Key,
            contentType: body.mime_type,
            contentLength: body.size_bytes,
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
          upload_headers: { 'Content-Type': body.mime_type },
          expires_at: expiresAt,
          callback_url: `/v1/attachments/${attachmentId}/confirm`,
        };
      });

      return reply.code(201).send(result);
    },
  );

  // POST /v1/attachments/:id/confirm (F-OFF-305, phase 2 of 2)
  // Officina confirms that the file has been uploaded to S3.
  // The server performs a HeadObject to verify ContentLength + ContentType
  // match the attachment row, then flips processed: false → true.
  // Idempotent: re-calling on an already-processed attachment returns 200
  // without re-calling S3. Only the original uploader may confirm.
  app.post(
    '/v1/attachments/:id/confirm',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request, reply) => {
      const { id } = ConfirmParamsSchema.parse(request.params);
      const tenantId = request.tenantId!;
      const cognitoSub = request.userId!;

      // Capture the response payload AFTER withContext resolves (i.e. after
      // Prisma COMMIT). Calling reply.send() inside the callback would cause
      // inject() to resolve before COMMIT, making DB assertions in tests see
      // pre-commit state. All other route handlers follow this same pattern.
      const result = await app.withContext({ tenantId }, async (tx) => {
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
        let attachment;
        try {
          attachment = await tx.attachment.findFirstOrThrow({
            where: { id, tenantId },
          });
        } catch (err) {
          if (
            typeof err === 'object' &&
            err !== null &&
            'code' in err &&
            (err as { code: unknown }).code === 'P2025'
          ) {
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

        // Idempotent: skip S3 verify when already processed.
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

        if (
          head.contentLength !== attachment.sizeBytes ||
          head.contentType !== attachment.mimeType
        ) {
          throw businessError(
            'attachment.confirm.metadata_mismatch',
            422,
            `S3 metadata non matcha: size ${head.contentLength}/${attachment.sizeBytes}, type ${head.contentType}/${attachment.mimeType}.`,
          );
        }

        const updated = await tx.attachment.update({
          where: { id },
          data: { processed: true },
        });

        return serializeAttachment(updated);
      });

      return reply.code(200).send(result);
    },
  );
};

export default attachmentsRoutes;
