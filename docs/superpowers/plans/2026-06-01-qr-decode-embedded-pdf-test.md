# QR decode from embedded PDF (test gap) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decode-verify the QR **as embedded in the rendered tag PDF** (not a regenerated standalone buffer) and assert the QR image is embedded exactly once, closing the two TODOs in `vehicle-tag-renderer.test.ts`.

**Architecture:** A test-only helper extracts DeviceRGB image XObjects from a rendered PDF (pdf-lib low-level object walk + `node:zlib` inflate), reconstructs an RGBA buffer, and `jsQR`-decodes it. A discovery step first confirms pdf-lib's actual image storage format so the helper is written against reality, not assumptions.

**Tech Stack:** Vitest, pdf-lib, jsqr, node:zlib (built-in). No production code change, no new dependency.

**Spec:** `docs/superpowers/specs/2026-06-01-qr-decode-embedded-pdf-design.md`

---

## File Structure

- `packages/api/tests/helpers/pdf-image.ts` — **new** test helper: `extractEmbeddedRgbImages(pdf)`.
- `packages/api/tests/unit/lib/vehicle-tag-renderer.test.ts` — **modify**: add the embedded-decode + dedup-count tests; clean the two TODO comments; keep the existing standalone test.

No production source, schema, infra, or docs changes.

---

## Task 1: Discovery — confirm pdf-lib's embedded-image format

**Goal:** Learn the real XObject dict (ColorSpace / BitsPerComponent / Filter / DecodeParms / Width / Height) and image count before writing the decoder. Throwaway — nothing committed.

**Files:**
- Temp: `packages/api/tests/unit/lib/_qr-discovery.test.ts` (deleted at end of task)

- [ ] **Step 1: Write a temporary introspection test**

Create `packages/api/tests/unit/lib/_qr-discovery.test.ts`:

```ts
import { describe, it } from 'vitest';
import { PDFDocument, PDFRawStream, PDFName } from 'pdf-lib';
import { renderTagPdf } from '../../../src/lib/vehicle-tag-renderer.js';

describe('discovery', () => {
  it('dumps image XObject dicts', async () => {
    const buf = await renderTagPdf('GO-288-QPWZ');
    const pdf = await PDFDocument.load(buf);
    let n = 0;
    for (const [ref, obj] of pdf.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFRawStream)) continue;
      const subtype = obj.dict.lookup(PDFName.of('Subtype'));
      if (String(subtype) !== '/Image') continue;
      n++;
      const keys = ['ColorSpace', 'BitsPerComponent', 'Filter', 'DecodeParms', 'Width', 'Height'];
      const info: Record<string, string> = { ref: String(ref) };
      for (const k of keys) info[k] = String(obj.dict.lookup(PDFName.of(k)));
      info.rawBytes = String(obj.contents.length);
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(info));
    }
    // eslint-disable-next-line no-console
    console.log(`IMAGE_XOBJECT_COUNT=${n}`);
  });
});
```

- [ ] **Step 2: Run it and record the output**

Run: `pnpm --filter @garageos/api test -- _qr-discovery`
Capture the logged lines. Note for each image XObject: `ColorSpace`, `BitsPerComponent`, `Filter`, whether `DecodeParms` (a PNG `Predictor`) is present, `Width`/`Height`, and the total `IMAGE_XOBJECT_COUNT`.

**Expected (the format the helper in Task 2 assumes):** one `/DeviceRGB`, `BitsPerComponent 8`, `Filter /FlateDecode`, `DecodeParms` absent (`undefined`), `Width 256` `Height 256` — plus possibly one `/DeviceGray` SMask (the alpha). `IMAGE_XOBJECT_COUNT` is 1 (RGB only) or 2 (RGB + SMask).

- [ ] **Step 3: Reconcile with Task 2's assumptions**

- If the QR image is `/DeviceRGB` 8bpc FlateDecode with **no** `DecodeParms` → Task 2 code is correct as written; proceed unchanged.
- If `DecodeParms`/`Predictor` **is** present → `zlib.inflateSync` alone won't reconstruct samples; in Task 2 add a PNG-predictor un-filter pass (Predictor ≥ 10 = PNG predictors, per-row filter byte). Document the observed Predictor value in a code comment.
- If ColorSpace is **not** `/DeviceRGB` (e.g. `/DeviceGray` or `[/Indexed ...]`) → adjust Task 2's selector and the RGBA reconstruction (grayscale = 1 sample/pixel; indexed = palette lookup). Document the observed format.

- [ ] **Step 4: Delete the discovery test**

```bash
rm packages/api/tests/unit/lib/_qr-discovery.test.ts
```

No commit for this task (throwaway).

---

## Task 2: `extractEmbeddedRgbImages` helper

**Files:**
- Create: `packages/api/tests/helpers/pdf-image.ts`

- [ ] **Step 1: Write the helper**

Create `packages/api/tests/helpers/pdf-image.ts` (adjust per Task 1 findings if they diverged from the expected format):

```ts
import zlib from 'node:zlib';

import { PDFDocument, PDFName, PDFNumber, PDFRawStream } from 'pdf-lib';

export interface EmbeddedRgbImage {
  width: number;
  height: number;
  /** Raw RGB samples, length === width * height * 3. */
  rgb: Buffer;
}

/**
 * Extract every DeviceRGB image XObject from a (loaded) PDF, decompressed to
 * raw RGB samples. Test-only helper used to verify the QR embedded in the tag
 * PDF actually decodes.
 *
 * Assumes the format pdf-lib produces for an `embedPng`'d RGBA PNG, confirmed
 * by the discovery step in the plan: 8-bit /DeviceRGB, /FlateDecode, no
 * predictor. The PNG alpha is stored by pdf-lib as a separate /DeviceGray
 * SMask, which this skips (we only need the RGB pixels).
 */
export function extractEmbeddedRgbImages(pdf: PDFDocument): EmbeddedRgbImage[] {
  const out: EmbeddedRgbImage[] = [];
  for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const dict = obj.dict;
    if (String(dict.lookup(PDFName.of('Subtype'))) !== '/Image') continue;
    if (String(dict.lookup(PDFName.of('ColorSpace'))) !== '/DeviceRGB') continue;
    const width = (dict.lookup(PDFName.of('Width')) as PDFNumber).asNumber();
    const height = (dict.lookup(PDFName.of('Height')) as PDFNumber).asNumber();
    const rgb = Buffer.from(zlib.inflateSync(Buffer.from(obj.contents)));
    out.push({ width, height, rgb });
  }
  return out;
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @garageos/api typecheck`
Expected: PASS (no callers yet; pure addition).

- [ ] **Step 3: Commit**

```bash
git add packages/api/tests/helpers/pdf-image.ts
git commit -m "test(api): add extractEmbeddedRgbImages PDF helper"
```

---

## Task 3: Embedded-decode + dedup assertions

**Files:**
- Modify: `packages/api/tests/unit/lib/vehicle-tag-renderer.test.ts`

- [ ] **Step 1: Wire the helper import + an RGB→RGBA adapter**

At the top of `packages/api/tests/unit/lib/vehicle-tag-renderer.test.ts`, add the import (alongside the existing pdf-lib / jsqr imports):

```ts
import { extractEmbeddedRgbImages } from '../../helpers/pdf-image.js';
```

Add a small local adapter near the top of the file (after the imports, before `describe`):

```ts
// jsQR expects RGBA; the embedded QR XObject is RGB (alpha lives in a separate
// SMask). Widen to RGBA with full opacity.
function rgbToRgba(rgb: Buffer, width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    out[j] = rgb[i]!;
    out[j + 1] = rgb[i + 1]!;
    out[j + 2] = rgb[i + 2]!;
    out[j + 3] = 255;
  }
  return out;
}
```

- [ ] **Step 2: Replace the count TODO test (line ~33-40) with a real dedup assertion**

Find the existing test:

```ts
  it('serialized PDF references embedded images (XObjects)', async () => {
    const buf = await renderTagPdf(SAMPLE);
    // pdf-lib doesn't expose direct image count; verify indirect via raw serialization
    // TODO: strengthen to assert count=1 to verify pdf-lib dedup
    // (single embedded image referenced by 14 drawImage calls per BR-026).
    const raw = buf.toString('binary');
    expect(raw).toMatch(/\/XObject/);
  });
```

Replace it with:

```ts
  it('embeds the QR image exactly once (pdf-lib dedup, BR-026)', async () => {
    const buf = await renderTagPdf(SAMPLE);
    const pdf = await PDFDocument.load(buf);
    // One DeviceRGB image XObject (the QR) referenced by all 14 drawImage calls.
    const images = extractEmbeddedRgbImages(pdf);
    expect(images).toHaveLength(1);
  });
```

- [ ] **Step 3: Add the embedded-decode test; relabel the standalone one**

Update the standalone test's note (it stays, but the misleading "not the one embedded" framing is now paired with a real embedded test). Change its leading comment from:

```ts
  it('QR code payload decodes back to https://app.garageos.it/v/<garageCode>', async () => {
    // Note: decodes a standalone QR buffer, not the one embedded in the PDF.
    // pdf-lib's embedPng + drawImage is lossless, but a physical print test
    // is needed to confirm end-to-end scannability.
    // Generate QR directly to verify our payload contract
```

to:

```ts
  it('QR payload contract: standalone-encoded QR decodes to the tag URL', async () => {
    // Belt-and-suspenders payload check against a freshly encoded QR buffer.
    // The embedded-in-PDF decode lives in the next test; a physical print test
    // is still the only end-to-end scannability confirmation.
```

Then add the new embedded-decode test immediately after it:

```ts
  it('QR embedded in the rendered PDF decodes to the tag URL', async () => {
    const buf = await renderTagPdf(SAMPLE);
    const pdf = await PDFDocument.load(buf);
    const images = extractEmbeddedRgbImages(pdf);
    expect(images.length).toBeGreaterThan(0);
    const qr = images[0]!;
    const decoded = jsQR(rgbToRgba(qr.rgb, qr.width, qr.height), qr.width, qr.height);
    expect(decoded).not.toBeNull();
    expect(decoded?.data).toBe(`https://app.garageos.it/v/${SAMPLE}`);
  });
```

- [ ] **Step 4: Run the suite**

Run: `pnpm --filter @garageos/api test -- vehicle-tag-renderer`
Expected: PASS — the existing %PDF/A4/TAG_LAYOUT/standalone tests, the new dedup test (count === 1), and the new embedded-decode test (URL match).

If the embedded-decode test fails to find a QR / decodes null, return to Task 1 findings: confirm the ColorSpace selector and predictor handling in `pdf-image.ts` match the real dict.

- [ ] **Step 5: Commit**

```bash
git add packages/api/tests/unit/lib/vehicle-tag-renderer.test.ts
git commit -m "test(api): decode QR embedded in tag PDF + assert single embed"
```

---

## Task 4: Typecheck, push, PR, watch CI

- [ ] **Step 1: Repo-wide typecheck**

Run: `pnpm -r typecheck`
Expected: PASS across all packages.

- [ ] **Step 2: Push**

```bash
git push -u origin test/qr-embedded-pdf-decode
```

- [ ] **Step 3: Open the PR**

```bash
gh pr create --title "test(api): decode QR embedded in tag PDF (close #5 verification gap)" --body "<fill from CLAUDE.md template>"
```

PR body must cover:
- **What:** decode the QR **as embedded in** the rendered tag PDF (extract DeviceRGB XObject → inflate → jsQR), and assert the QR is embedded exactly once (BR-026 dedup). New test-only helper `tests/helpers/pdf-image.ts`. Existing standalone-payload test kept.
- **Why:** closes the verification gap noted at `vehicle-tag-renderer.test.ts:36,43` (backlog item "#5"); the embed→save→reload path was previously unverified.
- **Implementation notes:** test-only, no production/dep/infra change (`node:zlib` built-in); format confirmed via a throwaway discovery step before writing the decoder.
- **Tests:** 3 relevant assertions (dedup count=1, embedded decode URL, standalone payload) + full renderer suite green; `pnpm -r typecheck` green.

- [ ] **Step 4: Watch CI**

Run: `gh pr checks --watch`
Expected: all green. Fix-forward on red.

---

## Self-Review (completed by plan author)

**Spec coverage:**
- Decode QR embedded in PDF (spec §Approach 1-5) → Task 3 Step 3 + helper Task 2. ✓
- Assert embedded exactly once / BR-026 (spec §What line-36) → Task 3 Step 2. ✓
- Keep existing standalone test (spec §Scope) → Task 3 Step 3 (relabel, not delete). ✓
- No production/dep/infra change (spec §Scope) → only `tests/**` touched; `node:zlib` built-in. ✓
- De-risk pdf-lib format unknown (spec §Risk R1/R3) → Task 1 discovery + Task 3 Step 4 fallback. ✓
- Helper isolated as a named unit (spec §Helper contract) → `tests/helpers/pdf-image.ts`, `extractEmbeddedRgbImages`. ✓

**Placeholder scan:** only the PR body `<fill>` (deliberate, per CLAUDE.md template). No TODO/TBD in code. ✓

**Type/name consistency:** `extractEmbeddedRgbImages(pdf): EmbeddedRgbImage[]` with `{ width, height, rgb }` — defined Task 2, consumed Task 3 (`.length`, `[0]`, `.rgb/.width/.height`). `rgbToRgba(rgb, width, height)` consistent. `SAMPLE` is the existing const in the test file. ✓

**Risks addressed:**
- pdf-lib format unknown → Task 1 discovery gates the decoder; Task 3 Step 4 points back to it on failure. ✓
- PNG predictor (R3) → explicitly checked in Task 1 Step 2/3, handled if present. ✓
- Commit header length (recent #143 trip) → both commit subjects ≤72 chars. ✓
