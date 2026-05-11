// BR-180 — Dimensioni e formato allegati.
// 10 MB per file, 10 allegati max per intervento, mime whitelist.
// Sequence: count → mime → size (most-restrictive first).
// Server enforces 25MB hard ceiling and identical mime whitelist —
// the 10MB UI cap is the BR-180 product rule.

export const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
] as const;

export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_INTERVENTION = 10;

export type ValidationError =
  | { code: 'mime_not_supported'; received: string }
  | { code: 'size_exceeded'; received: number; max: number }
  | { code: 'count_exceeded'; current: number; max: number };

export function validateFileForUpload(file: File, currentCount: number): ValidationError | null {
  if (currentCount >= MAX_ATTACHMENTS_PER_INTERVENTION) {
    return {
      code: 'count_exceeded',
      current: currentCount,
      max: MAX_ATTACHMENTS_PER_INTERVENTION,
    };
  }
  if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(file.type)) {
    return { code: 'mime_not_supported', received: file.type };
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return {
      code: 'size_exceeded',
      received: file.size,
      max: MAX_FILE_SIZE_BYTES,
    };
  }
  return null;
}
