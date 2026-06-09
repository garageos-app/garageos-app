import { randomInt } from 'node:crypto';

// Physical transfer code shared with the recipient out-of-band (F-CLI-401,
// physical_code method). Alphabet excludes ambiguous glyphs (0 1 I O Q S U),
// mirroring the BR-020 garage-code alphabet. Format: TR-XXXX-XXXX.
const ALPHABET = '23456789ABCDEFGHJKLMNPRTVWXYZ';

export const TRANSFER_CODE_RE = /^TR-[2-9A-HJ-NPRTV-Z]{4}-[2-9A-HJ-NPRTV-Z]{4}$/;

function group(): string {
  let out = '';
  for (let i = 0; i < 4; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export function generateTransferCode(): string {
  return `TR-${group()}-${group()}`;
}
