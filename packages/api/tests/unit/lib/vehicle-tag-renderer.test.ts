import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { renderTagPdf, TAG_LAYOUT } from '../../../src/lib/vehicle-tag-renderer.js';
import { extractEmbeddedRgbImages } from '../../helpers/pdf-image.js';

// jsQR expects RGBA; the embedded QR XObject is RGB (qrcode emits an opaque
// PNG, so pdf-lib stores no alpha SMask). Widen to RGBA with full opacity.
function rgbToRgba(rgb: Buffer, width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    out[j] = rgb[i]!;
    out[j + 1] = rgb[i + 1]!;
    out[j + 2] = rgb[i + 2]!;
    out[j + 3] = 255;
  }
  return out;
}

describe('renderTagPdf', () => {
  const SAMPLE = 'GO-288-QPWZ';

  it('returns a non-empty Buffer with %PDF magic bytes', async () => {
    const buf = await renderTagPdf(SAMPLE);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
  });

  it('produces a 1-page A4 PDF', async () => {
    const buf = await renderTagPdf(SAMPLE);
    const pdf = await PDFDocument.load(buf);
    expect(pdf.getPageCount()).toBe(1);
    const page = pdf.getPage(0);
    expect(page.getWidth()).toBeCloseTo(TAG_LAYOUT.A4_WIDTH_PT, 0);
    expect(page.getHeight()).toBeCloseTo(TAG_LAYOUT.A4_HEIGHT_PT, 0);
  });

  it('exports TAG_LAYOUT constants', () => {
    expect(TAG_LAYOUT.COLS).toBe(2);
    expect(TAG_LAYOUT.ROWS).toBe(7);
    expect(TAG_LAYOUT.TOTAL_LABELS).toBe(14);
    expect(TAG_LAYOUT.QR_BASE_URL).toBe('https://app.garageos.it/v');
  });

  it('embeds the QR image exactly once (pdf-lib dedup, BR-026)', async () => {
    const buf = await renderTagPdf(SAMPLE);
    const pdf = await PDFDocument.load(buf);
    // One DeviceRGB image XObject (the QR) referenced by all 14 drawImage calls.
    const images = extractEmbeddedRgbImages(pdf);
    expect(images).toHaveLength(1);
  });

  it('QR payload contract: standalone-encoded QR decodes to the tag URL', async () => {
    // Belt-and-suspenders payload check against a freshly encoded QR buffer.
    // The embedded-in-PDF decode lives in the next test; a physical print test
    // is still the only end-to-end scannability confirmation.
    const QRCode = (await import('qrcode')).default;
    const qrPng = await QRCode.toBuffer(`${TAG_LAYOUT.QR_BASE_URL}/${SAMPLE}`, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 256,
    });
    const png = PNG.sync.read(qrPng);
    const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    expect(decoded).not.toBeNull();
    expect(decoded?.data).toBe(`https://app.garageos.it/v/${SAMPLE}`);
  });

  it('QR embedded in the rendered PDF decodes to the tag URL', async () => {
    const buf = await renderTagPdf(SAMPLE);
    const pdf = await PDFDocument.load(buf);
    const images = extractEmbeddedRgbImages(pdf);
    expect(images.length).toBeGreaterThan(0);
    const qr = images[0]!;
    const decoded = jsQR(rgbToRgba(qr.rgb, qr.width, qr.height), qr.width, qr.height);
    expect(decoded).not.toBeNull();
    expect(decoded?.data).toBe(`https://app.garageos.it/v/${SAMPLE}`);
  });
});
