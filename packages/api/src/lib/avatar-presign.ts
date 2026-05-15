import { env } from '../config/env.js';
import { S3UnavailableError, presignGetObject } from './s3.js';
import { businessError } from './business-error.js';

// Avatar presigned GET URL expiry. 15 minutes mirrors the attachment
// view-url flow (lib/attachments.ts). The web app caches /users/me via
// React Query with staleTime=5min, so URLs refresh well before expiry.
export const AVATAR_PRESIGN_EXPIRY_SECONDS = 900;

// Transforms a stored S3 key (e.g. 'avatars/users/<uuid>.jpg') into a
// short-lived presigned GET URL. Used by serializeUserMe to convert the
// DB-stored key into a wire-format URL.
//
// Maps S3UnavailableError → users.me.avatar.s3_unavailable (502); other
// errors bubble up to be handled as 500 by the global handler.
export async function keyToPresignedUrl(key: string): Promise<string> {
  try {
    return await presignGetObject({
      bucket: env.S3_ATTACHMENTS_BUCKET,
      key,
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
}
