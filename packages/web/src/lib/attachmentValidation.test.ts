import { describe, expect, it } from 'vitest';

import {
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE_BYTES,
  MAX_ATTACHMENTS_PER_INTERVENTION,
  validateFileForUpload,
} from './attachmentValidation';

function makeFile(name: string, type: string, sizeBytes: number): File {
  // JSDOM File: contents irrelevant, only size + type matter for validation.
  // We control the reported size via Blob constructor using a zero-fill array.
  const blob = new Blob([new Uint8Array(sizeBytes)], { type });
  return new File([blob], name, { type });
}

describe('attachmentValidation constants', () => {
  it('exposes BR-180 constants', () => {
    expect(MAX_FILE_SIZE_BYTES).toBe(10 * 1024 * 1024);
    expect(MAX_ATTACHMENTS_PER_INTERVENTION).toBe(10);
    expect(ALLOWED_MIME_TYPES).toEqual([
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/heic',
      'application/pdf',
    ]);
  });
});

describe('validateFileForUpload — count boundary (BR-180)', () => {
  const okFile = makeFile('a.pdf', 'application/pdf', 1024);

  it('returns null when currentCount is 0', () => {
    expect(validateFileForUpload(okFile, 0)).toBeNull();
  });

  it('returns null when currentCount is 9 (room for one more)', () => {
    expect(validateFileForUpload(okFile, 9)).toBeNull();
  });

  it('returns count_exceeded when currentCount is 10', () => {
    expect(validateFileForUpload(okFile, 10)).toEqual({
      code: 'count_exceeded',
      current: 10,
      max: 10,
    });
  });
});

describe('validateFileForUpload — mime whitelist (BR-180)', () => {
  it('accepts all 5 whitelisted mimes', () => {
    for (const mime of ALLOWED_MIME_TYPES) {
      const file = makeFile('a', mime, 1024);
      expect(validateFileForUpload(file, 0)).toBeNull();
    }
  });

  it('rejects image/gif with mime_not_supported', () => {
    const file = makeFile('a.gif', 'image/gif', 1024);
    expect(validateFileForUpload(file, 0)).toEqual({
      code: 'mime_not_supported',
      received: 'image/gif',
    });
  });

  it('rejects video/mp4', () => {
    const file = makeFile('a.mp4', 'video/mp4', 1024);
    expect(validateFileForUpload(file, 0)?.code).toBe('mime_not_supported');
  });

  it('rejects application/zip', () => {
    const file = makeFile('a.zip', 'application/zip', 1024);
    expect(validateFileForUpload(file, 0)?.code).toBe('mime_not_supported');
  });

  it('rejects empty mime string', () => {
    const file = makeFile('a', '', 1024);
    expect(validateFileForUpload(file, 0)?.code).toBe('mime_not_supported');
  });
});

describe('validateFileForUpload — size boundary (BR-180)', () => {
  it('accepts size = MAX - 1 byte', () => {
    const file = makeFile('a.pdf', 'application/pdf', MAX_FILE_SIZE_BYTES - 1);
    expect(validateFileForUpload(file, 0)).toBeNull();
  });

  it('accepts size = MAX exactly', () => {
    const file = makeFile('a.pdf', 'application/pdf', MAX_FILE_SIZE_BYTES);
    expect(validateFileForUpload(file, 0)).toBeNull();
  });

  it('rejects size = MAX + 1 with size_exceeded', () => {
    const file = makeFile('a.pdf', 'application/pdf', MAX_FILE_SIZE_BYTES + 1);
    expect(validateFileForUpload(file, 0)).toEqual({
      code: 'size_exceeded',
      received: MAX_FILE_SIZE_BYTES + 1,
      max: MAX_FILE_SIZE_BYTES,
    });
  });

  it('accepts empty file (0 bytes) — server validates positivity, UI does not pre-reject', () => {
    const file = makeFile('a.pdf', 'application/pdf', 0);
    expect(validateFileForUpload(file, 0)).toBeNull();
  });
});

describe('validateFileForUpload — sequence order', () => {
  it('count is checked before mime (already-full beats unsupported mime)', () => {
    const file = makeFile('a.gif', 'image/gif', 1024);
    expect(validateFileForUpload(file, 10)?.code).toBe('count_exceeded');
  });

  it('mime is checked before size (unsupported mime beats oversized)', () => {
    const file = makeFile('a.zip', 'application/zip', MAX_FILE_SIZE_BYTES + 1);
    expect(validateFileForUpload(file, 0)?.code).toBe('mime_not_supported');
  });
});
