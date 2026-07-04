// packages/api/tests/unit/lib/intervention-pdf-renderer.test.ts
import { describe, expect, it } from 'vitest';
import { inflateSync } from 'zlib';
import { PDFDocument } from 'pdf-lib';
import {
  renderInterventionPdf,
  INTERVENTION_PDF_LAYOUT,
  type InterventionPdfData,
} from '../../../src/lib/intervention-pdf-renderer.js';

/**
 * Extract all text drawn in a pdf-lib PDF buffer.
 *
 * pdf-lib compresses content streams with FlateDecode and encodes each glyph
 * run as a hex string (<hex...> Tj). This helper:
 *  1. Finds every "stream\n ... endstream" block.
 *  2. Inflates it (skipping non-deflate streams like XRef).
 *  3. Decodes every <hex> sequence back to Latin-1 text.
 *
 * The returned string is the concatenation of all decoded text fragments,
 * suitable for regex assertions on drawn content.
 */
function extractPdfText(buf: Buffer): string {
  const hexPattern = /<([0-9A-Fa-f]+)>/g;
  let text = '';
  let pos = 0;
  const startMarker = Buffer.from('stream\n');
  const endMarker = Buffer.from('endstream');
  while (pos < buf.length) {
    const start = buf.indexOf(startMarker, pos);
    if (start === -1) break;
    const dataStart = start + startMarker.length;
    const dataEnd = buf.indexOf(endMarker, dataStart);
    if (dataEnd === -1) break;
    const chunk = buf.slice(dataStart, dataEnd);
    try {
      const inflated = inflateSync(chunk).toString('latin1');
      // Decode hex-encoded glyph runs (pdf-lib uses <hex> Tj for WinAnsi fonts).
      for (const m of inflated.matchAll(hexPattern)) {
        if (m[1]) text += Buffer.from(m[1], 'hex').toString('latin1');
      }
    } catch {
      // Non-deflate stream (e.g. XRef) — skip.
    }
    pos = dataEnd + endMarker.length;
  }
  return text;
}

const BASE: InterventionPdfData = {
  tenant: {
    businessName: 'Officina Bianchi SRL',
    addressLine: 'Via Roma 12',
    city: 'Milano',
    vatNumber: '01234567890',
    phone: '02-1234567',
  },
  customerName: 'Mario Rossi',
  vehicle: { plate: 'AB123CD', make: 'Fiat', model: 'Panda', garageCode: 'GA0001' },
  interventionDate: '2026-05-23',
  odometerKm: 60000,
  typeName: 'Tagliando',
  checklistItems: ['Cambio olio', 'Controllo freni'],
  description: 'Sostituzione olio motore e filtri.\nControllo freni: àèìòù ok.',
  partsReplaced: [
    { name: 'Filtro olio', code: 'FO-12', quantity: 1, notes: null },
    { name: 'Olio motore 5W30', code: null, quantity: 4, notes: 'sintetico' },
  ],
  operatorName: 'Giuseppe Rossi',
  status: 'active',
  cancelledReason: null,
};

describe('renderInterventionPdf', () => {
  it('returns a non-empty Buffer with %PDF magic bytes', async () => {
    const buf = await renderInterventionPdf(BASE);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(800);
    expect(buf.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
  });

  it('produces a 1-page A4 PDF', async () => {
    const buf = await renderInterventionPdf(BASE);
    const pdf = await PDFDocument.load(buf);
    expect(pdf.getPageCount()).toBe(1);
    const page = pdf.getPage(0);
    expect(page.getWidth()).toBeCloseTo(INTERVENTION_PDF_LAYOUT.A4_WIDTH_PT, 0);
    expect(page.getHeight()).toBeCloseTo(INTERVENTION_PDF_LAYOUT.A4_HEIGHT_PT, 0);
  });

  it('exports layout constants', () => {
    expect(INTERVENTION_PDF_LAYOUT.A4_WIDTH_PT).toBeCloseTo(595.28, 0);
    expect(INTERVENTION_PDF_LAYOUT.A4_HEIGHT_PT).toBeCloseTo(841.89, 0);
  });

  it('renders without throwing for cancelled status (ANNULLATO banner)', async () => {
    const buf = await renderInterventionPdf({
      ...BASE,
      status: 'cancelled',
      cancelledReason: 'Richiesta cliente',
    });
    expect(buf.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
    // pdf-lib compresses content streams and hex-encodes each glyph run;
    // extractPdfText inflates + decodes <hex> sequences back to readable text.
    const text = extractPdfText(buf);
    expect(text).toMatch(/ANNULLATO/);
    expect(text).toMatch(/Richiesta cliente/);
  });

  it('renders without throwing with no parts, no customer, no logo', async () => {
    const buf = await renderInterventionPdf({
      ...BASE,
      partsReplaced: [],
      customerName: null,
    });
    expect(buf.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
    const text = extractPdfText(buf);
    expect(text).not.toMatch(/Mario Rossi/);
    expect(text).not.toMatch(/Intestatario/);
  });

  it('renders checklist labels under "Voci eseguite" and no "Titolo"', async () => {
    const text = extractPdfText(await renderInterventionPdf(BASE));
    expect(text).toMatch(/Voci eseguite/);
    expect(text).toMatch(/Cambio olio/);
    expect(text).toMatch(/Controllo freni/);
    expect(text).not.toMatch(/Titolo/);
  });

  it('omits the "Descrizione" label when description is empty', async () => {
    const text = extractPdfText(await renderInterventionPdf({ ...BASE, description: '' }));
    expect(text).not.toMatch(/Descrizione/);
    // checklist still renders — it is the mandatory body
    expect(text).toMatch(/Voci eseguite/);
  });

  it('embeds a PNG logo when provided', async () => {
    // 1x1 transparent PNG
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    );
    const buf = await renderInterventionPdf(BASE, { bytes: png, format: 'png' });
    const raw = buf.toString('binary');
    expect(raw).toMatch(/\/XObject/);
  });
});
