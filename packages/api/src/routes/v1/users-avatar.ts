import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import type { FastifyPluginAsync } from 'fastify';

import { env } from '../../config/env.js';
import { AVATAR_PRESIGN_EXPIRY_SECONDS } from '../../lib/avatar-presign.js';
import { businessError } from '../../lib/business-error.js';
import { USER_ME_SELECT, serializeUserMe } from '../../lib/dtos/user-me.js';
import {
  S3ObjectNotFoundError,
  S3UnavailableError,
  getS3Client,
  headObject,
  presignPutObject,
} from '../../lib/s3.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { requireOfficinaPool } from '../../middleware/require-officina-pool.js';
import { tenantContext } from '../../middleware/tenant-context.js';

// /v1/users/me/avatar/* — F-OFF-007 follow-up (slice L1).
//
// Three endpoints sharing the same auth + tenant-binding pattern:
//   POST   /upload-url  → issue presigned PUT for deterministic key
//   POST   /confirm     → HeadObject verify + UPDATE users.avatar_url
//   DELETE              → DeleteObject + UPDATE users.avatar_url=NULL
//
// Storage key is deterministic per user: `avatars/users/<userId>.jpg`.
// Output format is always JPEG (frontend resizes via canvas).
// Cross-tenant guard: findFirstOrThrow({ cognitoSub, tenantId }) before
// each operation — defense-in-depth post-#27 RLS split on users.

function avatarKey(userId: string): string {
  return `avatars/users/${userId}.jpg`;
}

const userAvatarRoutes: FastifyPluginAsync = async (app) => {
  // POST /v1/users/me/avatar/upload-url
  // Body: {} (empty). Mime is fixed server-side to image/jpeg because
  // the frontend always uploads canvas-encoded JPEG.
  app.post(
    '/v1/users/me/avatar/upload-url',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request, reply) => {
      const tenantId = request.tenantId!;
      const cognitoSub = request.userId!;

      // Bind to (cognitoSub, tenantId) — defense in depth (see users.ts
      // for the full rationale). Post-migration 0004 users SELECT is
      // permissive; the tenant boundary is application-layer enforced.
      const user = await app.withContext({ tenantId }, (tx) =>
        tx.user.findFirstOrThrow({
          where: { cognitoSub, tenantId },
          select: { id: true },
        }),
      );

      const key = avatarKey(user.id);
      const bucket = env.S3_ATTACHMENTS_BUCKET;

      let uploadUrl: string;
      try {
        uploadUrl = await presignPutObject({
          bucket,
          key,
          contentType: 'image/jpeg',
          expiresInSeconds: AVATAR_PRESIGN_EXPIRY_SECONDS,
        });
      } catch (err) {
        if (err instanceof S3UnavailableError) {
          throw businessError(
            'users.me.avatar.s3_unavailable',
            502,
            'Servizio storage temporaneamente non disponibile.',
          );
        }
        throw err;
      }

      const expiresAt = new Date(Date.now() + AVATAR_PRESIGN_EXPIRY_SECONDS * 1000).toISOString();
      return reply.code(200).send({
        upload_url: uploadUrl,
        upload_method: 'PUT' as const,
        upload_headers: { 'Content-Type': 'image/jpeg' },
        expires_at: expiresAt,
      });
    },
  );

  // POST /v1/users/me/avatar/confirm
  // Body: {}. Verifies the object landed on S3 via HeadObject
  // (mime must be image/jpeg) then flips users.avatar_url to the key.
  // Idempotent: re-calling with the same key produces the same result.
  app.post(
    '/v1/users/me/avatar/confirm',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request, reply) => {
      const tenantId = request.tenantId!;
      const cognitoSub = request.userId!;

      const result = await app.withContext({ tenantId }, async (tx) => {
        const user = await tx.user.findFirstOrThrow({
          where: { cognitoSub, tenantId },
          select: { id: true },
        });

        const key = avatarKey(user.id);
        const bucket = env.S3_ATTACHMENTS_BUCKET;

        // HeadObject: verifies the object exists and matches mime. We
        // do NOT enforce content-length (Blob size is variable) — abuse
        // is mitigated by the deterministic per-user key and auth gate.
        let head: { contentLength: number; contentType: string };
        try {
          head = await headObject(bucket, key);
        } catch (err) {
          if (err instanceof S3ObjectNotFoundError) {
            throw businessError(
              'users.me.avatar.upload_not_found',
              422,
              "File non trovato su S3 — l'upload non è atterrato o è scaduto.",
            );
          }
          if (err instanceof S3UnavailableError) {
            throw businessError(
              'users.me.avatar.s3_unavailable',
              502,
              'Servizio storage temporaneamente non disponibile.',
            );
          }
          throw err;
        }

        if (head.contentType !== 'image/jpeg') {
          throw businessError(
            'users.me.avatar.invalid_mime',
            422,
            'Il file caricato deve essere JPEG.',
          );
        }

        const updated = await tx.user.update({
          where: { id: user.id },
          data: { avatarUrl: key },
          select: USER_ME_SELECT,
        });
        return serializeUserMe(updated);
      });

      return reply.code(200).send(result);
    },
  );

  // DELETE /v1/users/me/avatar
  // Removes avatar: best-effort DeleteObject on S3 + UPDATE
  // users.avatar_url = NULL. Idempotent: works whether avatar exists
  // or not. S3 delete failures are logged but do not fail the request
  // — the deterministic key means the orphaned object will be
  // overwritten on the next upload.
  app.delete(
    '/v1/users/me/avatar',
    {
      preHandler: [requireAuth, requireOfficinaPool, tenantContext],
    },
    async (request, reply) => {
      const tenantId = request.tenantId!;
      const cognitoSub = request.userId!;

      await app.withContext({ tenantId }, async (tx) => {
        const user = await tx.user.findFirstOrThrow({
          where: { cognitoSub, tenantId },
          select: { id: true },
        });

        const key = avatarKey(user.id);
        const bucket = env.S3_ATTACHMENTS_BUCKET;

        // Best-effort delete on S3. If it fails (network, eventual
        // consistency, key already absent), the request still succeeds
        // — the deterministic key means a future upload overwrites the
        // orphan.
        try {
          await getS3Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        } catch (err) {
          request.log.warn({ err, key }, 'avatar S3 delete failed; ignoring');
        }

        await tx.user.update({
          where: { id: user.id },
          data: { avatarUrl: null },
        });
      });

      return reply.code(204).send();
    },
  );
};

export default userAvatarRoutes;
