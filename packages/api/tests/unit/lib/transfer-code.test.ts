import { describe, expect, it } from 'vitest';

import { generateTransferCode, TRANSFER_CODE_RE } from '../../../src/lib/transfer-code.js';

describe('transfer-code', () => {
  it('generates codes matching TR-XXXX-XXXX with the no-ambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateTransferCode();
      expect(code).toMatch(TRANSFER_CODE_RE);
      // No ambiguous characters: 0 1 I O Q S U
      expect(code.slice(3)).not.toMatch(/[01IOQSU]/);
    }
  });

  it('produces varied codes (not a constant)', () => {
    const set = new Set(Array.from({ length: 50 }, () => generateTransferCode()));
    expect(set.size).toBeGreaterThan(1);
  });

  it('TRANSFER_CODE_RE rejects malformed codes', () => {
    expect('tr-9k4m-7p2x').not.toMatch(TRANSFER_CODE_RE); // lowercase
    expect('TR-9K4M7P2X').not.toMatch(TRANSFER_CODE_RE); // missing dash
    expect('TR-9K4-7P2X').not.toMatch(TRANSFER_CODE_RE); // wrong length
    expect('TR-9K4O-7P2X').not.toMatch(TRANSFER_CODE_RE); // contains O
    expect('GO-234-ABCD').not.toMatch(TRANSFER_CODE_RE); // garage code shape
  });
});
