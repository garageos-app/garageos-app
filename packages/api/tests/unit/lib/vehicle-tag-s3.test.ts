import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, HeadObjectCommand, PutObjectCommand, NoSuchKey } from '@aws-sdk/client-s3';
import { getOrCreateTagPresignedUrl } from '../../../src/lib/vehicle-tag-s3.js';
import { _resetS3ClientForTests } from '../../../src/lib/s3.js';

const s3Mock = mockClient(S3Client);

beforeAll(() => {
  // feedback_aws_sdk_presigner_credentials_chain
  process.env.AWS_ACCESS_KEY_ID ??= 'test';
  process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
  process.env.AWS_REGION ??= 'eu-south-1';
  process.env.S3_ATTACHMENTS_BUCKET ??= 'garageos-test-attachments';
});

beforeEach(() => {
  _resetS3ClientForTests();
  s3Mock.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getOrCreateTagPresignedUrl', () => {
  it('cache miss: HeadObject NoSuchKey → renders + PutObject + returns presigned URL', async () => {
    s3Mock.on(HeadObjectCommand).rejects(new NoSuchKey({ message: 'not found', $metadata: {} }));
    s3Mock.on(PutObjectCommand).resolves({});

    const result = await getOrCreateTagPresignedUrl({
      bucket: 'garageos-test-attachments',
      garageCode: 'GO-288-QPWZ',
    });

    expect(result.url).toContain('garageos-test-attachments');
    expect(result.url).toContain('tags/GO-288-QPWZ.pdf');
    expect(result.expiresAt).toBeInstanceOf(Date);
    expect(result.cacheHit).toBe(false);
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1);
  });

  it('cache hit: HeadObject 200 → no PutObject, returns presigned URL', async () => {
    s3Mock.on(HeadObjectCommand).resolves({
      ContentType: 'application/pdf',
      ContentLength: 12345,
    });

    const result = await getOrCreateTagPresignedUrl({
      bucket: 'garageos-test-attachments',
      garageCode: 'GO-288-QPWZ',
    });

    expect(result.url).toContain('tags/GO-288-QPWZ.pdf');
    expect(result.cacheHit).toBe(true);
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  it('PutObject failure → throws vehicle_tag.s3_upload_failed', async () => {
    s3Mock.on(HeadObjectCommand).rejects(new NoSuchKey({ message: 'not found', $metadata: {} }));
    s3Mock.on(PutObjectCommand).rejects(new Error('S3 502 BadGateway'));

    await expect(
      getOrCreateTagPresignedUrl({
        bucket: 'garageos-test-attachments',
        garageCode: 'GO-288-QPWZ',
      }),
    ).rejects.toMatchObject({ name: 'vehicle_tag.s3_upload_failed' });
  });

  it('HeadObject 403 (non-NoSuchKey) → throws vehicle_tag.s3_head_failed', async () => {
    const { S3ServiceException } = await import('@aws-sdk/client-s3');
    s3Mock.on(HeadObjectCommand).rejects(
      Object.assign(
        new S3ServiceException({
          name: 'AccessDenied',
          $fault: 'client',
          $metadata: { httpStatusCode: 403 },
          message: 'Access Denied',
        }),
      ),
    );

    await expect(
      getOrCreateTagPresignedUrl({
        bucket: 'garageos-test-attachments',
        garageCode: 'GO-288-QPWZ',
      }),
    ).rejects.toMatchObject({ name: 'vehicle_tag.s3_head_failed' });
  });
});
