import { GetObjectCommand } from '@aws-sdk/client-s3';

import { getS3Client } from './s3.js';
import type { LogoImage } from './intervention-pdf-renderer.js';

// F-OFF-309 — best-effort tenant logo resolution for the intervention PDF.
// tenant.logoUrl may be either a bare S3 key ("logos/<id>.png") or a full
// https URL (legacy). Either way we read the object bytes server-side and
// sniff the format. ANY failure (null/empty url, NoSuchKey, IAM denied,
// unsupported format) returns null so the PDF export NEVER fails over a logo.

function toKey(logoUrl: string): string {
  if (!/^https?:\/\//i.test(logoUrl)) return logoUrl.replace(/^\/+/, '');
  try {
    return new URL(logoUrl).pathname.replace(/^\/+/, '');
  } catch {
    return logoUrl;
  }
}

function sniffFormat(bytes: Buffer): 'png' | 'jpg' | null {
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpg';
  }
  return null;
}

export async function resolveTenantLogo(
  bucket: string,
  logoUrl: string | null,
): Promise<LogoImage | null> {
  if (!logoUrl) return null;
  try {
    const client = getS3Client();
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: toKey(logoUrl) }));
    if (!res.Body) return null;
    const arr = await (
      res.Body as { transformToByteArray: () => Promise<Uint8Array> }
    ).transformToByteArray();
    const bytes = Buffer.from(arr);
    const format = sniffFormat(bytes);
    if (!format) return null;
    return { bytes, format };
  } catch {
    // Swallow — logo is decorative; the export must proceed without it.
    return null;
  }
}
