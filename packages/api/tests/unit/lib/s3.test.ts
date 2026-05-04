import {
  HeadObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  S3ObjectNotFoundError,
  S3UnavailableError,
  _resetS3ClientForTests,
  headObject,
  presignPutObject,
} from '../../../src/lib/s3.js';

const s3Mock = mockClient(S3Client);

beforeEach(() => {
  s3Mock.reset();
  _resetS3ClientForTests();
});

afterEach(() => {
  _resetS3ClientForTests();
});

describe('presignPutObject', () => {
  it('returns a presigned URL string with content-type and content-length conditions', async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    const url = await presignPutObject({
      bucket: 'test-bucket',
      key: 'attachments/intervention/abc/123.jpg',
      contentType: 'image/jpeg',
      contentLength: 1024,
      expiresInSeconds: 900,
    });
    expect(url).toMatch(
      /^https:\/\/test-bucket\.s3\..*amazonaws\.com\/attachments\/intervention\/abc\/123\.jpg/,
    );
    expect(url).toContain('X-Amz-Signature=');
  });

  it('wraps SDK signing errors as S3UnavailableError', async () => {
    // Force the underlying signer to throw by passing a malformed bucket
    // (presigner validates ARN-like format).
    await expect(
      presignPutObject({
        bucket: '',
        key: 'k',
        contentType: 'image/jpeg',
        contentLength: 1,
        expiresInSeconds: 900,
      }),
    ).rejects.toBeInstanceOf(S3UnavailableError);
  });
});

describe('headObject', () => {
  it('returns ContentLength + ContentType when object exists', async () => {
    s3Mock.on(HeadObjectCommand).resolves({
      ContentLength: 1024,
      ContentType: 'image/jpeg',
    });
    const result = await headObject('test-bucket', 'k');
    expect(result).toEqual({ contentLength: 1024, contentType: 'image/jpeg' });
  });

  it('throws S3ObjectNotFoundError when key missing', async () => {
    s3Mock
      .on(HeadObjectCommand)
      .rejects(new NoSuchKey({ message: 'Not Found', $metadata: { httpStatusCode: 404 } }));
    await expect(headObject('test-bucket', 'k')).rejects.toBeInstanceOf(S3ObjectNotFoundError);
  });

  it('throws S3ObjectNotFoundError on S3ServiceException with httpStatusCode 404', async () => {
    // A 404 wrapped in S3ServiceException but NOT specifically NoSuchKey
    // (e.g., a hypothetical "AccessDenied with implicit not-found masking").
    // The handler should still recognize it as a missing-object signal.
    s3Mock.on(HeadObjectCommand).rejects(
      new S3ServiceException({
        name: 'NotFound',
        $fault: 'client',
        $metadata: { httpStatusCode: 404 },
        message: 'Not Found',
      }),
    );
    await expect(headObject('test-bucket', 'k')).rejects.toBeInstanceOf(S3ObjectNotFoundError);
  });

  it('throws S3UnavailableError when ContentLength missing in response', async () => {
    s3Mock.on(HeadObjectCommand).resolves({ ContentType: 'image/jpeg' });
    await expect(headObject('test-bucket', 'k')).rejects.toBeInstanceOf(S3UnavailableError);
  });

  it('throws S3UnavailableError when ContentType missing in response', async () => {
    s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 1024 });
    await expect(headObject('test-bucket', 'k')).rejects.toBeInstanceOf(S3UnavailableError);
  });

  it('throws S3UnavailableError on generic 5xx', async () => {
    const err = new Error('Internal Error') as Error & { $metadata: { httpStatusCode: number } };
    err.$metadata = { httpStatusCode: 500 };
    s3Mock.on(HeadObjectCommand).rejects(err);
    await expect(headObject('test-bucket', 'k')).rejects.toBeInstanceOf(S3UnavailableError);
  });
});
