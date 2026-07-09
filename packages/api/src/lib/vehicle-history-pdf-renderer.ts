import { PDFDocument, StandardFonts, rgb, type PDFPage } from 'pdf-lib';

import { DOT, TIMES, formatDateIt, formatKm, wrapText } from './pdf-format.js';

// F-CLI-501 — customer-facing full vehicle-history PDF, A4 portrait, MULTI-page.
// Aggregates shop interventions across all tenants that worked on the vehicle
// (BR-150), so the header is GarageOS-branded (no single-officina logo) and
// each intervention is labelled with its own officina + city. internal_notes
// are NEVER passed in. All formatting is manual (no Intl/ICU).

const A4_WIDTH_PT = 595.28;
const A4_HEIGHT_PT = 841.89;
const MARGIN = 50;
const LINE = 16;
const FOOTER_H = 30; // reserved band above the bottom margin for the footer

export interface VehicleHistoryInterventionData {
  interventionDate: string; // ISO yyyy-MM-dd
  odometerKm: number;
  typeName: string;
  tenantName: string;
  // Stable grouping key for grouped mode — tenant.businessName is NOT unique,
  // so two distinct officine could share a name. Optional: the customer 'inline'
  // path doesn't group and doesn't set it. Falls back to tenantName when absent.
  tenantId?: string;

  // BR-300/303/308: frozen checklist labels, already sorted by the caller.
  checklistItems: string[];
  description: string; // may be '' since #251
  partsReplaced: { name: string; code: string | null; quantity: number; notes: string | null }[];
}

export type VehicleHistoryPdfMode = 'inline' | 'grouped' | 'anonymous';

export interface VehicleHistoryPdfData {
  vehicle: {
    plate: string;
    make: string;
    model: string;
    version: string | null;
    garageCode: string | null;
    vin: string;
    year: number | null;
    fuelType: string | null;
  };
  generatedAt: string; // ISO yyyy-MM-dd
  interventions: VehicleHistoryInterventionData[];
  // Officina labelling. Default 'inline' preserves the customer PDF (F-CLI-501):
  // officina appended to each intervention row. 'grouped' (officina export, show
  // names) buckets interventions under per-officina headers ordered by most-recent
  // activity. 'anonymous' (officina export, hide names) omits every officina label.
  mode?: VehicleHistoryPdfMode;
}

export async function renderVehicleHistoryPdf(data: VehicleHistoryPdfData): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const contentWidth = A4_WIDTH_PT - 2 * MARGIN;

  let page: PDFPage = pdf.addPage([A4_WIDTH_PT, A4_HEIGHT_PT]);
  let y = A4_HEIGHT_PT - MARGIN;

  const newPage = (): void => {
    page = pdf.addPage([A4_WIDTH_PT, A4_HEIGHT_PT]);
    y = A4_HEIGHT_PT - MARGIN;
  };
  const ensureSpace = (needed: number): void => {
    if (y - needed < MARGIN + FOOTER_H) newPage();
  };

  // --- Header (first page) ---
  page.drawText('STORICO MANUTENZIONE VEICOLO', { x: MARGIN, y, size: 16, font: bold });
  page.drawText('GarageOS', {
    x: A4_WIDTH_PT - MARGIN - bold.widthOfTextAtSize('GarageOS', 12),
    y,
    size: 12,
    font: bold,
    color: rgb(0.6, 0.6, 0.6),
  });
  y -= LINE + 6;

  const v = data.vehicle;
  const line1 =
    `${v.make} ${v.model}` +
    (v.version ? ` ${v.version}` : '') +
    ` ${DOT} ${v.plate}` +
    (v.garageCode ? ` ${DOT} cod. ${v.garageCode}` : '');
  page.drawText(line1, { x: MARGIN, y, size: 11, font });
  y -= LINE;

  const detailBits = [`VIN: ${v.vin}`, v.year != null ? `Anno ${v.year}` : null, v.fuelType].filter(
    (b): b is string => Boolean(b),
  );
  page.drawText(detailBits.join(` ${DOT} `), {
    x: MARGIN,
    y,
    size: 9,
    font,
    color: rgb(0.3, 0.3, 0.3),
  });
  y -= LINE;

  page.drawText(`Documento generato il ${formatDateIt(data.generatedAt)}`, {
    x: MARGIN,
    y,
    size: 9,
    font,
    color: rgb(0.3, 0.3, 0.3),
  });
  y -= LINE + 4;

  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: A4_WIDTH_PT - MARGIN, y },
    thickness: 1,
    color: rgb(0.8, 0.8, 0.8),
  });
  y -= LINE;

  // --- Count line / empty-state ---
  const mode: VehicleHistoryPdfMode = data.mode ?? 'inline';

  // Draw one intervention block. `showInlineOfficina` appends " · officina" to the
  // type row (customer 'inline' mode); grouped/anonymous suppress the inline label.
  const drawIntervention = (
    it: VehicleHistoryInterventionData,
    showInlineOfficina: boolean,
  ): void => {
    const hasDesc = it.description.trim() !== '';
    const descLines = hasDesc ? wrapText(it.description, font, 10, contentWidth - 12) : [];
    const checkLines = it.checklistItems.length;
    const partLines = it.partsReplaced.length;
    const blockLines =
      2 +
      (checkLines > 0 ? 1 + checkLines : 0) +
      descLines.length +
      (partLines > 0 ? 1 + partLines : 0);
    const blockHeight = blockLines * (LINE - 2) + 16;
    ensureSpace(blockHeight);

    page.drawLine({
      start: { x: MARGIN, y: y + 6 },
      end: { x: A4_WIDTH_PT - MARGIN, y: y + 6 },
      thickness: 0.5,
      color: rgb(0.85, 0.85, 0.85),
    });
    page.drawText(`${formatDateIt(it.interventionDate)} ${DOT} ${formatKm(it.odometerKm)} km`, {
      x: MARGIN,
      y,
      size: 11,
      font: bold,
    });
    y -= LINE;

    const typeRow = showInlineOfficina ? `${it.typeName} ${DOT} ${it.tenantName}` : it.typeName;
    page.drawText(typeRow, { x: MARGIN, y, size: 10, font, color: rgb(0.2, 0.2, 0.2) });
    y -= LINE;

    if (checkLines > 0) {
      page.drawText('Voci eseguite:', { x: MARGIN, y, size: 10, font: bold });
      y -= LINE - 2;
      for (const label of it.checklistItems) {
        page.drawText(`${DOT} ${label}`, { x: MARGIN + 12, y, size: 10, font });
        y -= LINE - 2;
      }
    }
    for (const dl of descLines) {
      page.drawText(dl, { x: MARGIN + 12, y, size: 10, font });
      y -= LINE - 2;
    }
    if (partLines > 0) {
      page.drawText('Ricambi:', { x: MARGIN, y, size: 10, font: bold });
      y -= LINE - 2;
      for (const p of it.partsReplaced) {
        const code = p.code ? ` (cod. ${p.code})` : '';
        const notes = p.notes ? ` - ${p.notes}` : '';
        page.drawText(`${DOT} ${p.name}${code} ${TIMES}${p.quantity}${notes}`, {
          x: MARGIN + 12,
          y,
          size: 10,
          font,
        });
        y -= LINE - 2;
      }
    }
    y -= 10; // spacing between interventions
  };

  // Per-officina section header (grouped mode only).
  const drawGroupHeader = (officinaName: string): void => {
    ensureSpace(LINE + 12);
    y -= 4;
    page.drawText(officinaName, { x: MARGIN, y, size: 12, font: bold });
    y -= LINE + 2;
  };

  const n = data.interventions.length;
  if (n === 0) {
    page.drawText('Nessun intervento officina registrato', { x: MARGIN, y, size: 11, font });
  } else {
    const label = n === 1 ? 'intervento officina registrato' : 'interventi officina registrati';
    page.drawText(`${n} ${label}`, { x: MARGIN, y, size: 11, font: bold });
    y -= LINE + 4;

    if (mode === 'grouped') {
      // Bucket by officina preserving first-seen order. Interventions arrive sorted
      // date-desc, so a tenant's first appearance is its most recent intervention →
      // group order == most-recent-activity order.
      const groups: { name: string; items: VehicleHistoryInterventionData[] }[] = [];
      const indexByKey = new Map<string, number>();
      for (const it of data.interventions) {
        const key = it.tenantId ?? it.tenantName;
        let gi = indexByKey.get(key);
        if (gi === undefined) {
          gi = groups.length;
          indexByKey.set(key, gi);
          groups.push({ name: it.tenantName, items: [] });
        }
        groups[gi]!.items.push(it);
      }
      for (const g of groups) {
        drawGroupHeader(g.name);
        for (const it of g.items) drawIntervention(it, false);
      }
    } else {
      // 'inline' (customer default) keeps the per-row officina label; 'anonymous' drops it.
      for (const it of data.interventions) drawIntervention(it, mode === 'inline');
    }
  }

  // --- Footers (Pagina N di M) — drawn after content so M is final ---
  const pages = pdf.getPages();
  const total = pages.length;
  const footerY = MARGIN - 20;
  pages.forEach((p, i) => {
    p.drawText(`Pagina ${i + 1} di ${total}`, {
      x: MARGIN,
      y: footerY,
      size: 9,
      font,
      color: rgb(0.5, 0.5, 0.5),
    });
    p.drawText('GarageOS', {
      x: A4_WIDTH_PT - MARGIN - bold.widthOfTextAtSize('GarageOS', 9),
      y: footerY,
      size: 9,
      font: bold,
      color: rgb(0.6, 0.6, 0.6),
    });
  });

  const bytes = await pdf.save();
  return Buffer.from(bytes);
}

export const VEHICLE_HISTORY_PDF_LAYOUT = {
  A4_WIDTH_PT,
  A4_HEIGHT_PT,
  MARGIN,
} as const;
