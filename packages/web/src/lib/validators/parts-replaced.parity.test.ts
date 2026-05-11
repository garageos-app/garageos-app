import { describe, expect, it } from 'vitest';

// Web base schema — created in parts-replaced.ts
import { BasePartReplacedSchema } from './parts-replaced';

// Backend authoritative schema imported via deep relative path.
// Dev-time only (this is a test file). We deliberately do NOT add
// @garageos/database as a web runtime dep to keep Prisma client out
// of the Vite bundle. The cross-package import sits outside
// tsconfig.app.json's file list, surfacing as TS6307 under `tsc -b`;
// Vitest resolves it fine at test time. @ts-ignore (not @ts-expect-error)
// because the diagnostic position is fragile — `@ts-expect-error` is
// reported as "Unused" depending on subtle line-counting interactions
// with the rest of the file. If the diagnostic ever goes away (e.g.
// vitest tsconfig override), this suppression silently no-ops.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore TS6307 cross-package dev-time-only import
import { PartReplacedSchema as BackendPartReplacedSchema } from '../../../../database/src/validators/intervention';

describe('PartReplacedSchema parity (web base vs backend)', () => {
  it('both schemas accept the canonical BR-071 shape', () => {
    const sample = {
      name: 'Filtro olio',
      code: 'OF-123',
      quantity: 1,
      notes: 'Sostituito a 50.000 km',
    };

    const webParse = BasePartReplacedSchema.safeParse(sample);
    const backendParse = BackendPartReplacedSchema.safeParse(sample);

    expect(webParse.success).toBe(true);
    expect(backendParse.success).toBe(true);

    if (webParse.success && backendParse.success) {
      expect(Object.keys(webParse.data).sort()).toEqual(Object.keys(backendParse.data).sort());
    }
  });

  it('both reject a shape missing the required `name` field (BR-071 drift detection)', () => {
    // Catches the drift scenario from PR #85 final review:
    // implementer used {brand, code, description, quantity} instead of
    // the canonical {name, code, quantity, notes}.
    const wrongShape = {
      brand: 'Bosch',
      code: 'OF-123',
      description: 'Filtro olio',
      quantity: 1,
    };

    expect(BasePartReplacedSchema.safeParse(wrongShape).success).toBe(false);
    expect(BackendPartReplacedSchema.safeParse(wrongShape).success).toBe(false);
  });
});
