import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';

// F-OFF-309 — single intervention PDF, A4 portrait, 1 page.
// Customer-facing document handed to the client. internal_notes are NEVER
// passed in (route excludes them). All formatting is manual (no Intl/ICU) to
// stay independent of the Lambda runtime locale.

const A4_WIDTH_PT = 595.28;
const A4_HEIGHT_PT = 841.89;
const MARGIN = 50;
const LINE = 16;

// U+00B7 MIDDLE DOT — valid WinAnsi (0xB7). Used as field separator in header
// and vehicle line. \uXXXX escape avoids any editor encoding ambiguity.
const DOT = '\u00b7'; // U+00B7 MIDDLE DOT
// U+00D7 MULTIPLICATION SIGN — valid WinAnsi (0xD7). Used as quantity marker.
const TIMES = '\u00d7'; // U+00D7 MULTIPLICATION SIGN

export interface InterventionPdfData {
  tenant: {
    businessName: string;
    addressLine: string | null;
    city: string | null;
    vatNumber: string;
    phone: string | null;
  };
  customerName: string | null;
  vehicle: { plate: string; make: string; model: string; garageCode: string | null };
  interventionDate: string; // ISO yyyy-MM-dd
  odometerKm: number;
  typeName: string;
  title: string | null;
  description: string;
  partsReplaced: { name: string; code: string | null; quantity: number; notes: string | null }[];
  operatorName: string;
  status: 'active' | 'disputed' | 'cancelled';
  cancelledReason: string | null;
}

export interface LogoImage {
  bytes: Buffer;
  format: 'png' | 'jpg';
}

// dd/MM/yyyy from an ISO yyyy-MM-dd string — manual, no ICU dependency.
function formatDateIt(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

// Thousands separator with a dot (it-IT) — manual, no toLocaleString.
function formatKm(n: number): string {
  return Math.trunc(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

// Greedy word-wrap to a max width in points.
// Split on '\n' first, then filter empty tokens per line to avoid a spurious
// trailing '' entry from trailing whitespace (e.g. 'text '.split(/\s+/)).
// Intentional blank lines (empty rawLine after trimming) are preserved as-is.
function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const rawLine of text.split('\n')) {
    const words = rawLine.split(/\s+/).filter((w) => w !== '');
    if (words.length === 0) {
      // Preserve intentional blank line.
      out.push('');
      continue;
    }
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) > maxWidth && current) {
        out.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    out.push(current);
  }
  return out;
}

export async function renderInterventionPdf(
  data: InterventionPdfData,
  logo?: LogoImage | null,
): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([A4_WIDTH_PT, A4_HEIGHT_PT]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const contentWidth = A4_WIDTH_PT - 2 * MARGIN;

  let y = A4_HEIGHT_PT - MARGIN;

  const draw = (text: string, size: number, f: PDFFont, color = rgb(0, 0, 0)): void => {
    page.drawText(text, { x: MARGIN, y, size, font: f, color });
    y -= LINE;
  };

  // --- Header: optional logo + workshop block ---
  // Hoist address computation once so both logo and no-logo branches share it.
  // When BOTH addressLine and city are null, omit the DOT separator entirely
  // and render just "P.IVA <vat>" (Fix M1+M2).
  const addrParts = [data.tenant.addressLine, data.tenant.city].filter(Boolean).join(', ');
  const addrLine = addrParts
    ? `${addrParts} ${DOT} P.IVA ${data.tenant.vatNumber}`
    : `P.IVA ${data.tenant.vatNumber}`;

  let logoToUse: LogoImage | null = logo ?? null;
  if (logoToUse) {
    try {
      const img =
        logoToUse.format === 'png'
          ? await pdf.embedPng(logoToUse.bytes)
          : await pdf.embedJpg(logoToUse.bytes);
      const dims = img.scaleToFit(120, 60);
      page.drawImage(img, {
        x: MARGIN,
        y: y - dims.height + LINE,
        width: dims.width,
        height: dims.height,
      });
      // Shift the text header to the right of the logo.
      const headerX = MARGIN + dims.width + 16;
      page.drawText(data.tenant.businessName, { x: headerX, y, size: 16, font: bold });
      page.drawText(addrLine, {
        x: headerX,
        y: y - LINE,
        size: 9,
        font,
        color: rgb(0.3, 0.3, 0.3),
      });
      if (data.tenant.phone) {
        page.drawText(`Tel ${data.tenant.phone}`, {
          x: headerX,
          y: y - 2 * LINE,
          size: 9,
          font,
          color: rgb(0.3, 0.3, 0.3),
        });
      }
      y -= Math.max(dims.height, 3 * LINE) + LINE;
    } catch {
      // Embedding failed despite the sniff — fall back to text header below.
      logoToUse = null;
    }
  }
  if (!logoToUse) {
    draw(data.tenant.businessName, 16, bold);
    draw(addrLine, 9, font, rgb(0.3, 0.3, 0.3));
    if (data.tenant.phone) draw(`Tel ${data.tenant.phone}`, 9, font, rgb(0.3, 0.3, 0.3));
  }

  // Divider
  y -= 4;
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: A4_WIDTH_PT - MARGIN, y },
    thickness: 1,
    color: rgb(0.8, 0.8, 0.8),
  });
  y -= LINE;

  // --- Title block ---
  draw('SCHEDA INTERVENTO', 13, bold);
  if (data.customerName) draw(`Intestatario: ${data.customerName}`, 11, font);
  draw(
    `Veicolo: ${data.vehicle.plate} ${DOT} ${data.vehicle.make} ${data.vehicle.model}` +
      (data.vehicle.garageCode ? ` ${DOT} cod. ${data.vehicle.garageCode}` : ''),
    11,
    font,
  );
  draw(
    `Data: ${formatDateIt(data.interventionDate)}    Km: ${formatKm(data.odometerKm)}`,
    11,
    font,
  );
  draw(`Tipo: ${data.typeName}`, 11, font);

  // --- Cancelled banner ---
  if (data.status === 'cancelled') {
    y -= 4;
    draw(
      `INTERVENTO ANNULLATO${data.cancelledReason ? ` - ${data.cancelledReason}` : ''}`,
      11,
      bold,
      rgb(0.7, 0, 0),
    );
  }

  // --- Title / description ---
  // TODO(F-OFF-309): v1 single-page only — no overflow guard; long descriptions/parts can exceed
  // page bottom. Multi-page deferred.
  y -= 4;
  if (data.title) draw(`Titolo: ${data.title}`, 11, bold);
  draw('Descrizione:', 11, bold);
  for (const line of wrapText(data.description, font, 10, contentWidth - 12)) {
    page.drawText(line, { x: MARGIN + 12, y, size: 10, font });
    y -= LINE - 2;
  }

  // --- Parts ---
  if (data.partsReplaced.length > 0) {
    y -= 4;
    draw('Ricambi sostituiti:', 11, bold);
    for (const p of data.partsReplaced) {
      const code = p.code ? ` (cod. ${p.code})` : '';
      const notes = p.notes ? ` - ${p.notes}` : '';
      // Format: "· <name> (cod. <code>) ×<qty>" — DOT bullet, TIMES for qty.
      page.drawText(`${DOT} ${p.name}${code} ${TIMES}${p.quantity}${notes}`, {
        x: MARGIN + 12,
        y,
        size: 10,
        font,
      });
      y -= LINE - 2;
    }
  }

  // --- Footer ---
  page.drawText(`Operatore: ${data.operatorName}`, {
    x: MARGIN,
    y: MARGIN,
    size: 9,
    font,
    color: rgb(0.3, 0.3, 0.3),
  });
  page.drawText('GarageOS', {
    x: A4_WIDTH_PT - MARGIN - 50,
    y: MARGIN,
    size: 9,
    font: bold,
    color: rgb(0.6, 0.6, 0.6),
  });

  const bytes = await pdf.save();
  return Buffer.from(bytes);
}

export const INTERVENTION_PDF_LAYOUT = {
  A4_WIDTH_PT,
  A4_HEIGHT_PT,
  MARGIN,
} as const;
