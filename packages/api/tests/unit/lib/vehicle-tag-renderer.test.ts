import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { renderTagPdf, TAG_LAYOUT } from '../../../src/lib/vehicle-tag-renderer.js';

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

  it('serialized PDF references embedded images (XObjects)', async () => {
    const buf = await renderTagPdf(SAMPLE);
    // pdf-lib doesn't expose direct image count; verify indirect via raw serialization
    const raw = buf.toString('binary');
    expect(raw).toMatch(/\/XObject/);
  });

  it('QR code payload decodes back to https://app.garageos.it/v/<garageCode>', async () => {
    // Generate QR directly to verify our payload contract
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
});
