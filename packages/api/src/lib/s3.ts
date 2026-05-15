import {
  GetObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { env } from '../config/env.js';

// Lazy singleton — SDK client maintains HTTP/2 connection pool. One
// instance per Lambda warm container. Tests use `_resetS3ClientForTests`
// so aws-sdk-client-mock can override the underlying transport on
// every test setup.
let _client: S3Client | null = null;

export function getS3Client(): S3Client {
  if (_client) return _client;
  _client = new S3Client({ region: env.AWS_REGION });
  return _client;
}

// Test-only reset hook. Production code never imports this.
export function _resetS3ClientForTests(): void {
  _client = null;
}

export interface PresignedPutInput {
  bucket: string;
  key: string;
  contentType: string;
  contentLength?: number;
  expiresInSeconds: number;
}

// presignPutObject signs a PUT URL with ContentType condition (always)
// and ContentLength condition (when provided). Clients MUST send those
// headers exactly when PUTting, otherwise S3 rejects.
//
// ContentLength is required for attachment flows (size known at upload-url
// time) but optional for avatar flow (Blob is generated client-side from
// canvas with variable size). Defense-in-depth for unknown-length: the
// deterministic per-user key + auth-gated endpoint prevent abuse.
export async function presignPutObject(input: PresignedPutInput): Promise<string> {
  try {
    const command = new PutObjectCommand({
      Bucket: input.bucket,
      Key: input.key,
      ContentType: input.contentType,
      ...(input.contentLength !== undefined ? { ContentLength: input.contentLength } : {}),
    });
    return await getSignedUrl(getS3Client(), command, { expiresIn: input.expiresInSeconds });
  } catch (cause) {
    throw new S3UnavailableError('Failed to sign presigned PUT URL', cause);
  }
}

export interface PresignedGetInput {
  bucket: string;
  key: string;
  expiresInSeconds: number;
}

// presignGetObject signs a GET URL for downloading/viewing an existing S3
// object. Mirrors presignPutObject error handling and expiry semantics.
// Used by GET /v1/attachments/:id/view-url (F-OFF-301 detail page consumer).
export async function presignGetObject(input: PresignedGetInput): Promise<string> {
  try {
    const command = new GetObjectCommand({ Bucket: input.bucket, Key: input.key });
    return await getSignedUrl(getS3Client(), command, { expiresIn: input.expiresInSeconds });
  } catch (cause) {
    throw new S3UnavailableError('Failed to sign presigned GET URL', cause);
  }
}

export interface HeadObjectResult {
  contentLength: number;
  contentType: string;
}

// headObject verifies an uploaded object exists and returns its metadata.
// Distinguishes NoSuchKey / 404 (object missing → caller can return 422
// client-actionable) from generic AWS errors (5xx → caller returns 502).
export async function headObject(bucket: string, key: string): Promise<HeadObjectResult> {
  try {
    const response = await getS3Client().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    if (response.ContentLength == null || response.ContentType == null) {
      throw new S3UnavailableError('HeadObject response missing required metadata');
    }
    return { contentLength: response.ContentLength, contentType: response.ContentType };
  } catch (err) {
    if (err instanceof S3UnavailableError) throw err;
    if (err instanceof NoSuchKey || isHttpStatus(err, 404)) {
      throw new S3ObjectNotFoundError(`Object not found: ${key}`);
    }
    throw new S3UnavailableError('HeadObject failed', err);
  }
}

function isHttpStatus(err: unknown, status: number): boolean {
  return err instanceof S3ServiceException && err.$metadata.httpStatusCode === status;
}

// Typed errors thrown by this module. Route handler catches by `name`
// and maps each to the appropriate HTTP error code via businessError.
export class S3ObjectNotFoundError extends Error {
  override name = 'S3ObjectNotFoundError';
}

export class S3UnavailableError extends Error {
  override name = 'S3UnavailableError';
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
  }
}
