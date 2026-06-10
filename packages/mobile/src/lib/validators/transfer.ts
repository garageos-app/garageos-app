// Pure validator for the transfer code input. The regex mirrors the backend
// exactly (api/src/lib/transfer-code.ts TRANSFER_CODE_RE): TR-XXXX-XXXX where
// the alphabet excludes ambiguous glyphs (0 1 I O Q S U). The caller
// normalizes to trim().toUpperCase() first; the server stays authoritative.
export const TRANSFER_CODE_RE = /^TR-[2-9A-HJ-NPRTV-Z]{4}-[2-9A-HJ-NPRTV-Z]{4}$/;

export function validateTransferCode(code: string): string | undefined {
  if (!code) return 'Codice obbligatorio';
  if (!TRANSFER_CODE_RE.test(code)) return 'Codice non valido. Formato: TR-XXXX-XXXX';
  return undefined;
}
