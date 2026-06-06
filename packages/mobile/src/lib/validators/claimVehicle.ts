// Pure validator for the claim-vehicle form. The regex mirrors the backend
// exactly (routes/v1/me-vehicles.ts claimBodySchema, BR-020): GO-NNN-AAAA where
// digits are 2..9 and letters exclude I/O/Q/S/U. The caller normalizes the input
// to trim().toUpperCase() before calling, so this checks an already-uppercased
// string; the server stays authoritative.
const GARAGE_CODE_RE = /^GO-[2-9]{3}-[A-HJ-NPRTV-Z]{4}$/;

export function validateClaimForm(code: string): string | undefined {
  if (!code) return 'Codice obbligatorio';
  if (!GARAGE_CODE_RE.test(code)) return 'Codice non valido. Formato: GO-NNN-AAAA';
  return undefined;
}
