import { z } from 'zod';

// Source: docs/APPENDICE_B_DATABASE.md §5.1 — translated from Zod 3 to Zod 4
// (z.email / z.uuid / z.iso are top-level in v4; regex/min/max unchanged).

// BR-020 — garage_code format: GO-NNN-AAAA, digits 2-9, letters exclude I/O/Q/U
export const GarageCodeSchema = z.string().regex(/^GO-[2-9]{3}-[A-HJ-NPRTV-Z]{4}$/, {
  message: 'Formato codice GarageOS non valido. Atteso: GO-NNN-AAAA',
});

// BR-001 — VIN: 17 characters, alphanumeric excluding I/O/Q (ISO 3779)
export const VinSchema = z
  .string()
  .length(17, { message: 'Il VIN deve essere di 17 caratteri' })
  .regex(/^[A-HJ-NPR-Z0-9]{17}$/, {
    message: 'VIN contiene caratteri non validi',
  });

// Italian plate, current format (AA123BB). Historic plates are accepted in
// service-layer validation only; validator covers the canonical shape.
export const ItalianPlateSchema = z
  .string()
  .min(6)
  .max(10)
  .regex(/^[A-Z]{2}[0-9]{3}[A-Z]{2}$/, {
    message: 'Formato targa italiana non valido (esempio: AB123CD)',
  });

export const EmailSchema = z.email({ message: 'Email non valida' });

// Italian tax code: individual (16 alphanumerical) or legal entity (11 digits).
export const TaxCodeSchema = z
  .string()
  .regex(/^([A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z]|[0-9]{11})$/, {
    message: 'Codice fiscale non valido',
  });

// Italian VAT number (Partita IVA) — 11 digits.
export const VatNumberSchema = z
  .string()
  .regex(/^[0-9]{11}$/, { message: 'P.IVA deve essere di 11 cifre' });

// Phone: free-form, E.164-compatible bounds. Stricter parsing is service-layer.
export const PhoneSchema = z.string().min(6).max(30);

export const UuidSchema = z.uuid();

// ISO timestamps. APPENDICE_B writes `.datetime()` and `/^\d{4}-\d{2}-\d{2}$/`
// for date-only. In Zod 4 those live under z.iso; we keep the date regex
// for backwards compatibility with the existing schemas that accept it.
export const IsoTimestampSchema = z.iso.datetime();
export const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, {
  message: 'Formato data non valido. Atteso: YYYY-MM-DD',
});

export const PaginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(100).default(20),
});

export type GarageCode = z.infer<typeof GarageCodeSchema>;
export type Vin = z.infer<typeof VinSchema>;
export type ItalianPlate = z.infer<typeof ItalianPlateSchema>;
export type Email = z.infer<typeof EmailSchema>;
export type TaxCode = z.infer<typeof TaxCodeSchema>;
export type VatNumber = z.infer<typeof VatNumberSchema>;
export type Pagination = z.infer<typeof PaginationSchema>;
