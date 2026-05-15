import type { FastifyPluginAsync } from 'fastify';

import { env } from '../../config/env.js';
import { businessError } from '../../lib/business-error.js';
import { AVATAR_PRESIGN_EXPIRY_SECONDS } from '../../lib/avatar-presign.js';
import { S3UnavailableError, presignPutObject } from '../../lib/s3.js';
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
};

export default userAvatarRoutes;
