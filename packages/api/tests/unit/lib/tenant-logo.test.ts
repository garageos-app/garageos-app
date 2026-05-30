import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, GetObjectCommand, NoSuchKey } from '@aws-sdk/client-s3';
import { resolveTenantLogo } from '../../../src/lib/tenant-logo.js';
import { _resetS3ClientForTests } from '../../../src/lib/s3.js';

const s3Mock = mockClient(S3Client);

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const JPG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF_MAGIC = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);

function bodyOf(buf: Buffer) {
  return { transformToByteArray: async () => new Uint8Array(buf) };
}

beforeAll(() => {
  process.env.AWS_ACCESS_KEY_ID ??= 'test';
  process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
  process.env.AWS_REGION ??= 'eu-south-1';
});

beforeEach(() => {
  _resetS3ClientForTests();
  s3Mock.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveTenantLogo', () => {
  it('returns null when logoUrl is null', async () => {
    expect(await resolveTenantLogo('bucket', null)).toBeNull();
    expect(s3Mock.calls()).toHaveLength(0);
  });

  it('returns null when logoUrl is empty string', async () => {
    expect(await resolveTenantLogo('bucket', '')).toBeNull();
  });

  it('resolves a PNG logo to { format: "png" }', async () => {
    s3Mock.on(GetObjectCommand).resolves({ Body: bodyOf(PNG_MAGIC) as never });
    const logo = await resolveTenantLogo('bucket', 'logos/t1.png');
    expect(logo).not.toBeNull();
    expect(logo?.format).toBe('png');
    expect(logo?.bytes.subarray(0, 4)).toEqual(PNG_MAGIC.subarray(0, 4));
  });

  it('resolves a JPG logo to { format: "jpg" }', async () => {
    s3Mock.on(GetObjectCommand).resolves({ Body: bodyOf(JPG_MAGIC) as never });
    const logo = await resolveTenantLogo('bucket', 'logos/t1.jpg');
    expect(logo?.format).toBe('jpg');
  });

  it('returns null for an unsupported format (gif)', async () => {
    s3Mock.on(GetObjectCommand).resolves({ Body: bodyOf(GIF_MAGIC) as never });
    expect(await resolveTenantLogo('bucket', 'logos/t1.gif')).toBeNull();
  });

  it('returns null (never throws) when GetObject fails — IAM/NoSuchKey', async () => {
    s3Mock.on(GetObjectCommand).rejects(new NoSuchKey({ message: 'nope', $metadata: {} }));
    expect(await resolveTenantLogo('bucket', 'logos/missing.png')).toBeNull();
  });

  it('extracts the S3 key when logoUrl is a full https URL', async () => {
    s3Mock.on(GetObjectCommand).resolves({ Body: bodyOf(PNG_MAGIC) as never });
    const logo = await resolveTenantLogo(
      'bucket',
      'https://bucket.s3.eu-south-1.amazonaws.com/logos/t1.png',
    );
    expect(logo?.format).toBe('png');
    const call = s3Mock.commandCalls(GetObjectCommand)[0]!;
    expect(call.args[0].input.Key).toBe('logos/t1.png');
  });

  it('strips a leading slash from a bare key form', async () => {
    s3Mock.on(GetObjectCommand).resolves({ Body: bodyOf(PNG_MAGIC) as never });
    const logo = await resolveTenantLogo('bucket', '/logos/t1.png');
    expect(logo?.format).toBe('png');
    const call = s3Mock.commandCalls(GetObjectCommand)[0]!;
    expect(call.args[0].input.Key).toBe('logos/t1.png');
  });

  it('returns null for a truncated/corrupt buffer (< 3 bytes) without throwing', async () => {
    s3Mock.on(GetObjectCommand).resolves({ Body: bodyOf(Buffer.from([0xff])) as never });
    expect(await resolveTenantLogo('bucket', 'logos/corrupt.png')).toBeNull();
  });
});
