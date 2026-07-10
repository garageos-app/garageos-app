// packages/api/tests/unit/lib/vehicle-history-pdf-renderer.test.ts
import { describe, expect, it } from 'vitest';
import { inflateSync } from 'zlib';
import { PDFDocument } from 'pdf-lib';
import {
  renderVehicleHistoryPdf,
  VEHICLE_HISTORY_PDF_LAYOUT,
  type VehicleHistoryPdfData,
} from '../../../src/lib/vehicle-history-pdf-renderer.js';

// Inflate FlateDecode content streams and decode <hex> Tj glyph runs back to
// Latin-1 text (same approach as vehicles-export-pdf.test.ts).
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
      for (const m of inflated.matchAll(hexPattern)) {
        if (m[1]) text += Buffer.from(m[1], 'hex').toString('latin1');
      }
    } catch {
      // Non-deflate stream — skip.
    }
    pos = dataEnd + endMarker.length;
  }
  return text;
}

const VEHICLE = {
  plate: 'AB123CD',
  make: 'Fiat',
  model: 'Panda',
  version: '1.2 Easy',
  garageCode: 'GO-973-JJHM',
  vin: 'ZFA31200000123456',
  year: 2019,
  fuelType: 'Diesel',
};

function intervention(i: number) {
  return {
    interventionDate: `2026-0${(i % 9) + 1}-15`,
    odometerKm: 50000 + i * 1000,
    typeName: 'Tagliando',
    tenantName: 'Officina Bianchi Srl',
    checklistItems: ['Cambio olio', 'Controllo freni'],
    description: 'Sostituzione olio motore e filtri.\nControllo freni: àèìòù ok.',
    partsReplaced: [
      { name: 'Filtro olio', code: 'FO-12', quantity: 1, notes: null },
      { name: 'Olio motore 5W30', code: null, quantity: 4, notes: 'sintetico' },
    ],
  };
}

const BASE: VehicleHistoryPdfData = {
  vehicle: VEHICLE,
  generatedAt: '2026-06-09',
  interventions: [intervention(0), intervention(1)],
};

describe('renderVehicleHistoryPdf', () => {
  it('returns a non-empty Buffer with %PDF magic bytes and exports layout constants', async () => {
    const buf = await renderVehicleHistoryPdf(BASE);
    expect(buf.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
    expect(VEHICLE_HISTORY_PDF_LAYOUT.A4_WIDTH_PT).toBeCloseTo(595.28, 0);
    expect(VEHICLE_HISTORY_PDF_LAYOUT.A4_HEIGHT_PT).toBeCloseTo(841.89, 0);
  });

  it('renders the header, vehicle data, and per-intervention officina label with IT accents', async () => {
    const text = extractPdfText(await renderVehicleHistoryPdf(BASE));
    expect(text).toMatch(/STORICO MANUTENZIONE VEICOLO/);
    expect(text).toMatch(/Fiat Panda/);
    expect(text).toMatch(/Officina Bianchi Srl/);
    expect(text).toMatch(/àèìòù/);
    expect(text).toMatch(/Documento generato il 09\/06\/2026/);
  });

  it('renders an empty-state line for zero interventions on a single page', async () => {
    const buf = await renderVehicleHistoryPdf({ ...BASE, interventions: [] });
    const pdf = await PDFDocument.load(buf);
    expect(pdf.getPageCount()).toBe(1);
    expect(extractPdfText(buf)).toMatch(/Nessun intervento officina registrato/);
  });

  it('spans multiple pages for a long history and footers each page', async () => {
    const many = Array.from({ length: 40 }, (_, i) => intervention(i));
    const buf = await renderVehicleHistoryPdf({ ...BASE, interventions: many });
    const pdf = await PDFDocument.load(buf);
    expect(pdf.getPageCount()).toBeGreaterThan(1);
    const text = extractPdfText(buf);
    expect(text).toMatch(/Pagina 1 di /);
  });

  it('omits optional vehicle fields when null without printing "null"', async () => {
    const buf = await renderVehicleHistoryPdf({
      ...BASE,
      vehicle: { ...VEHICLE, version: null, year: null, fuelType: null, garageCode: null },
    });
    expect(extractPdfText(buf)).not.toMatch(/null/);
  });

  it('renders checklist labels under "Voci eseguite" and no "Titolo"', async () => {
    const text = extractPdfText(await renderVehicleHistoryPdf(BASE));
    expect(text).toMatch(/Voci eseguite/);
    expect(text).toMatch(/Cambio olio/);
    expect(text).not.toMatch(/Titolo/);
  });

  it('renders an intervention with an empty description without error', async () => {
    const buf = await renderVehicleHistoryPdf({
      ...BASE,
      interventions: [{ ...intervention(0), description: '' }],
    });
    const pdf = await PDFDocument.load(buf);
    expect(pdf.getPageCount()).toBe(1);
    // checklist still present even when the description is empty
    expect(extractPdfText(buf)).toMatch(/Voci eseguite/);
  });

  it('grouped mode: officina headers ordered by most-recent activity', async () => {
    const recent = {
      ...intervention(0),
      interventionDate: '2026-06-15',
      tenantName: 'Officina Recente',
    };
    const older = {
      ...intervention(1),
      interventionDate: '2026-01-15',
      tenantName: 'Officina Vecchia',
    };
    const text = extractPdfText(
      await renderVehicleHistoryPdf({ ...BASE, interventions: [recent, older], mode: 'grouped' }),
    );
    expect(text).toMatch(/Officina Recente/);
    expect(text).toMatch(/Officina Vecchia/);
    expect(text.indexOf('Officina Recente')).toBeLessThan(text.indexOf('Officina Vecchia'));
  });

  it('grouped mode: multiple interventions of one officina share a single header', async () => {
    const a1 = { ...intervention(0), interventionDate: '2026-06-15', tenantName: 'Officina A' };
    const a2 = { ...intervention(1), interventionDate: '2026-02-15', tenantName: 'Officina A' };
    const text = extractPdfText(
      await renderVehicleHistoryPdf({ ...BASE, interventions: [a1, a2], mode: 'grouped' }),
    );
    expect(text.match(/Officina A/g)?.length).toBe(1);
  });

  it('grouped mode: groups by tenantId, not by (non-unique) tenantName', async () => {
    // Two distinct officine sharing the same business_name (BR schema does not
    // enforce uniqueness) must NOT collapse under one header.
    const a1 = {
      ...intervention(0),
      interventionDate: '2026-06-15',
      tenantName: 'Officina Duplicata',
      tenantId: '11111111-1111-4111-8111-111111111111',
    };
    const a2 = {
      ...intervention(1),
      interventionDate: '2026-02-15',
      tenantName: 'Officina Duplicata',
      tenantId: '22222222-2222-4222-8222-222222222222',
    };
    const text = extractPdfText(
      await renderVehicleHistoryPdf({ ...BASE, interventions: [a1, a2], mode: 'grouped' }),
    );
    expect(text.match(/Officina Duplicata/g)?.length).toBe(2);
  });

  it('anonymous mode: omits every officina name but keeps intervention type', async () => {
    const text = extractPdfText(await renderVehicleHistoryPdf({ ...BASE, mode: 'anonymous' }));
    expect(text).not.toMatch(/Officina Bianchi Srl/);
    expect(text).toMatch(/Tagliando/);
  });

  it('inline mode (explicit) still labels each row with its officina', async () => {
    const text = extractPdfText(await renderVehicleHistoryPdf({ ...BASE, mode: 'inline' }));
    expect(text).toMatch(/Officina Bianchi Srl/);
  });
});
