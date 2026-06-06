import { GARAGE_CODE_RE } from '@/lib/validators/claimVehicle';

// Extracts the GarageOS code from a scanned QR payload. The vehicle tag encodes
// a URL https://app.garageos.it/v/GO-482-KXRT (Specifiche §4.5), but we also
// accept a bare code for robustness. Returns the normalized (trim+upper) code if
// it passes BR-020, null otherwise. Pure: no camera, no DB. The server stays
// authoritative; this only gates what we pre-fill into the form.
export function extractGarageCode(raw: string): string | null {
  if (!raw) return null;
  const withoutQuery = raw.split(/[?#]/)[0];
  const lastSeg = withoutQuery.split('/').filter(Boolean).pop() ?? '';
  const code = lastSeg.trim().toUpperCase();
  return GARAGE_CODE_RE.test(code) ? code : null;
}
