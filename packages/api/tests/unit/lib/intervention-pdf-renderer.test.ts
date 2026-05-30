// packages/api/tests/unit/lib/intervention-pdf-renderer.test.ts
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  renderInterventionPdf,
  INTERVENTION_PDF_LAYOUT,
  type InterventionPdfData,
} from '../../../src/lib/intervention-pdf-renderer.js';

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
  title: 'Tagliando completo 60.000 km',
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
  });

  it('renders without throwing with no title, no parts, no customer, no logo', async () => {
    const buf = await renderInterventionPdf({
      ...BASE,
      title: null,
      partsReplaced: [],
      customerName: null,
    });
    expect(buf.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
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
