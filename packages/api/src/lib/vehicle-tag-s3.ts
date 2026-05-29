import {
  GetObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { getS3Client } from './s3.js';
import { renderTagPdf } from './vehicle-tag-renderer.js';

// BR-026 — Tag PDF S3 cache: lazy generation + immutable.
// Key: tags/<garage_code>.pdf (immutable per BR-022).
// Presigned validity: 1h (3600s).

const PRESIGN_TTL_SECONDS = 3600;

export interface GetOrCreateInput {
  bucket: string;
  garageCode: string;
}

export interface GetOrCreateResult {
  url: string;
  expiresAt: Date;
  cacheHit: boolean;
}

function tagKey(garageCode: string): string {
  return `tags/${garageCode}.pdf`;
}

class VehicleTagS3HeadFailedError extends Error {
  override name = 'vehicle_tag.s3_head_failed';
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
  }
}

class VehicleTagS3UploadFailedError extends Error {
  override name = 'vehicle_tag.s3_upload_failed';
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
  }
}

export async function getOrCreateTagPresignedUrl(
  input: GetOrCreateInput,
): Promise<GetOrCreateResult> {
  const client = getS3Client();
  const key = tagKey(input.garageCode);

  // 1. HeadObject cache check
  let cacheHit: boolean;
  try {
    await client.send(new HeadObjectCommand({ Bucket: input.bucket, Key: key }));
    cacheHit = true;
  } catch (err) {
    if (err instanceof NoSuchKey || isHttpStatus(err, 404)) {
      cacheHit = false;
    } else {
      throw new VehicleTagS3HeadFailedError('HeadObject failed', err);
    }
  }

  // 2. Cache miss: render + PutObject
  if (!cacheHit) {
    const pdfBuffer = await renderTagPdf(input.garageCode);
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: input.bucket,
          Key: key,
          Body: pdfBuffer,
          ContentType: 'application/pdf',
          CacheControl: 'public, max-age=31536000, immutable',
        }),
      );
    } catch (err) {
      throw new VehicleTagS3UploadFailedError('PutObject failed', err);
    }
  }

  // 3. Presigned GET
  const url = await getSignedUrl(client, new GetObjectCommand({ Bucket: input.bucket, Key: key }), {
    expiresIn: PRESIGN_TTL_SECONDS,
  });
  const expiresAt = new Date(Date.now() + PRESIGN_TTL_SECONDS * 1000);

  return { url, expiresAt, cacheHit };
}

function isHttpStatus(err: unknown, status: number): boolean {
  return err instanceof S3ServiceException && err.$metadata.httpStatusCode === status;
}
