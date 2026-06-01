import zlib from 'node:zlib';

import { PDFDocument, PDFName, PDFNumber, PDFRawStream } from 'pdf-lib';

export interface EmbeddedRgbImage {
  width: number;
  height: number;
  /** Raw RGB samples, length === width * height * 3. */
  rgb: Buffer;
}

/**
 * Extract every DeviceRGB image XObject from a (loaded) PDF, decompressed to
 * raw RGB samples. Test-only helper used to verify the QR embedded in the tag
 * PDF actually decodes.
 *
 * Format confirmed via the plan's discovery step on a rendered tag PDF: the
 * QR is a single 8-bit /DeviceRGB image, /FlateDecode, no predictor
 * (`qrcode` emits an opaque PNG, so pdf-lib produces no separate SMask).
 * See docs/superpowers/plans/2026-06-01-qr-decode-embedded-pdf-test.md.
 */
export function extractEmbeddedRgbImages(pdf: PDFDocument): EmbeddedRgbImage[] {
  const out: EmbeddedRgbImage[] = [];
  for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const dict = obj.dict;
    if (String(dict.lookup(PDFName.of('Subtype'))) !== '/Image') continue;
    if (String(dict.lookup(PDFName.of('ColorSpace'))) !== '/DeviceRGB') continue;
    const width = (dict.lookup(PDFName.of('Width')) as PDFNumber).asNumber();
    const height = (dict.lookup(PDFName.of('Height')) as PDFNumber).asNumber();
    const rgb = Buffer.from(zlib.inflateSync(Buffer.from(obj.contents)));
    out.push({ width, height, rgb });
  }
  return out;
}
