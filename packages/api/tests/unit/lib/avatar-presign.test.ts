import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _resetS3ClientForTests } from '../../../src/lib/s3.js';
import { keyToPresignedUrl } from '../../../src/lib/avatar-presign.js';
import { serializeUserMe } from '../../../src/lib/dtos/user-me.js';

const s3Mock = mockClient(S3Client);

beforeEach(() => {
  s3Mock.reset();
  _resetS3ClientForTests();
  s3Mock.on(GetObjectCommand).resolves({});
});

afterEach(() => {
  _resetS3ClientForTests();
});

describe('keyToPresignedUrl', () => {
  it('returns a presigned URL for the configured attachments bucket', async () => {
    const url = await keyToPresignedUrl('avatars/users/u1.jpg');
    expect(url).toMatch(/avatars\/users\/u1\.jpg/);
    expect(url).toContain('X-Amz-Signature=');
  });
});

describe('serializeUserMe', () => {
  const baseRow = {
    id: 'u1',
    email: 'a@b.c',
    firstName: 'A',
    lastName: 'B',
    role: 'mechanic' as const,
    tenantId: 't1',
    locationId: null,
    phone: null,
    status: 'active' as const,
    createdAt: new Date(),
  };

  it('returns avatarUrl=null when DB field is null', async () => {
    const out = await serializeUserMe({ ...baseRow, avatarUrl: null });
    expect(out.avatarUrl).toBeNull();
  });

  it('returns presigned URL when DB field has a key', async () => {
    const out = await serializeUserMe({ ...baseRow, avatarUrl: 'avatars/users/u1.jpg' });
    expect(out.avatarUrl).toMatch(/avatars\/users\/u1\.jpg/);
    expect(out.avatarUrl).toContain('X-Amz-Signature=');
  });
});
