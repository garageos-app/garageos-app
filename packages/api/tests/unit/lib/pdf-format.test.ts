// packages/api/tests/unit/lib/pdf-format.test.ts
import { describe, expect, it } from 'vitest';
import { StandardFonts, PDFDocument } from 'pdf-lib';
import { DOT, TIMES, formatDateIt, formatKm, wrapText } from '../../../src/lib/pdf-format.js';

describe('pdf-format', () => {
  it('formatDateIt converts ISO yyyy-MM-dd to dd/MM/yyyy', () => {
    expect(formatDateIt('2026-05-23')).toBe('23/05/2026');
    expect(formatDateIt('2026-01-09T00:00:00.000Z')).toBe('09/01/2026');
  });

  it('formatKm inserts thousands separators with a dot', () => {
    expect(formatKm(60000)).toBe('60.000');
    expect(formatKm(0)).toBe('0');
    expect(formatKm(1234567)).toBe('1.234.567');
  });

  it('DOT and TIMES are the WinAnsi middle dot and multiplication sign', () => {
    expect(DOT).toBe('·');
    expect(TIMES).toBe('×');
  });

  it('wrapText greedily wraps to the max width and preserves blank lines', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const lines = wrapText('a\n\nbb', font, 10, 1000);
    expect(lines).toEqual(['a', '', 'bb']);
  });
});
