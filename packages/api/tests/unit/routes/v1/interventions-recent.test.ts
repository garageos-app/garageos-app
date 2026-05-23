import { describe, expect, it } from 'vitest';

import { recentQuerySchema } from '../../../../src/routes/v1/interventions-recent.js';

describe('recentQuerySchema', () => {
  it('applies default limit=10 when omitted', () => {
    expect(recentQuerySchema.parse({}).limit).toBe(10);
  });

  it('coerces limit string to int', () => {
    expect(recentQuerySchema.parse({ limit: '25' }).limit).toBe(25);
  });

  it('rejects limit=0', () => {
    expect(() => recentQuerySchema.parse({ limit: 0 })).toThrow();
  });

  it('rejects limit above max=50', () => {
    expect(() => recentQuerySchema.parse({ limit: 51 })).toThrow();
  });

  it('rejects negative limit', () => {
    expect(() => recentQuerySchema.parse({ limit: -1 })).toThrow();
  });

  it('rejects non-numeric limit', () => {
    expect(() => recentQuerySchema.parse({ limit: 'abc' })).toThrow();
  });
});
