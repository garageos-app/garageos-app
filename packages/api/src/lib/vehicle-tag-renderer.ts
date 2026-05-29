import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import QRCode from 'qrcode';

// BR-026 — Tag PDF generation lazy + immutable.
//
// Layout: A4 14-up Avery L7163 (99.1×38.1mm, 2 col × 7 rows).
// PDF immutabile per BR-022 (codice GarageOS immutabile): nessun parametro
// oltre `garageCode` influenza il rendering, quindi PDF dedupabile per
// garage_code key.

const A4_WIDTH_PT = 595.28;
const A4_HEIGHT_PT = 841.89;
const MM_PT = 2.83465; // 1mm in pt

// Avery L7163 layout
// Left margin (7.21mm) and right margin (4.59mm) are asymmetric per the official
// European datasheet. The right margin is NOT used directly — it is implicit from
// left + 2×(label width + gap). Using the correct left value avoids 2.56mm
// leftward shift vs. the die-cut that would clip content in the printer's
// non-printable zone (~5mm).
const LABEL_W_MM = 99.1;
const LABEL_H_MM = 38.1;
const PAGE_MARGIN_LEFT_MM = 7.21;
const PAGE_MARGIN_TOP_MM = 15.1;
const COL_GAP_MM = 0.0;
const ROW_GAP_MM = 0.0;
const COLS = 2;
const ROWS = 7;

const QR_BASE_URL = 'https://app.garageos.it/v';

export async function renderTagPdf(garageCode: string): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([A4_WIDTH_PT, A4_HEIGHT_PT]);
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  const small = await pdf.embedFont(StandardFonts.Helvetica);

  const qrPng = await QRCode.toBuffer(`${QR_BASE_URL}/${garageCode}`, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 256,
  });
  const qrImage = await pdf.embedPng(qrPng);

  const labelWPt = LABEL_W_MM * MM_PT;
  const labelHPt = LABEL_H_MM * MM_PT;
  const marginLeftPt = PAGE_MARGIN_LEFT_MM * MM_PT;
  const marginTopPt = PAGE_MARGIN_TOP_MM * MM_PT;
  const colGapPt = COL_GAP_MM * MM_PT;
  const rowGapPt = ROW_GAP_MM * MM_PT;

  // Constants that don't vary per cell — hoisted out of the loop for clarity.
  const codeFontSize = 18;
  const footerSize = 6;
  const qrSizePt = 26 * MM_PT;
  const BASELINE_OFFSET_PT = 4; // empirical descender compensation for 18pt Helvetica Bold

  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const x = marginLeftPt + col * (labelWPt + colGapPt);
      const yTop = A4_HEIGHT_PT - marginTopPt - row * (labelHPt + rowGapPt);
      const yBottom = yTop - labelHPt;

      // Codice large centrato sx
      page.drawText(garageCode, {
        x: x + 8 * MM_PT,
        y: yBottom + labelHPt / 2 + BASELINE_OFFSET_PT,
        size: codeFontSize,
        font,
        color: rgb(0, 0, 0),
      });

      // Footer "GarageOS"
      page.drawText('GarageOS', {
        x: x + 8 * MM_PT,
        y: yBottom + 4 * MM_PT,
        size: footerSize,
        font: small,
        color: rgb(0.4, 0.4, 0.4),
      });

      // QR a destra
      page.drawImage(qrImage, {
        x: x + labelWPt - qrSizePt - 4 * MM_PT,
        y: yBottom + (labelHPt - qrSizePt) / 2,
        width: qrSizePt,
        height: qrSizePt,
      });
    }
  }

  const bytes = await pdf.save();
  return Buffer.from(bytes);
}

// Esportato per testing + tuning
export const TAG_LAYOUT = {
  A4_WIDTH_PT,
  A4_HEIGHT_PT,
  COLS,
  ROWS,
  TOTAL_LABELS: COLS * ROWS,
  QR_BASE_URL,
} as const;
