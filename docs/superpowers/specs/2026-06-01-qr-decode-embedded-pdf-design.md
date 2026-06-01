# QR decode from embedded PDF (test gap) — design

**Date:** 2026-06-01
**Type:** `test(api)` — test-quality, zero production behavior change
**Branch (proposed):** `test/qr-embedded-pdf-decode`

## What

Close a verification gap in `packages/api/tests/unit/lib/vehicle-tag-renderer.test.ts`. Today the tag renderer (`src/lib/vehicle-tag-renderer.ts`) embeds a QR PNG into the A4 14-up tag PDF via `pdf.embedPng(qrPng)` + 14× `drawImage`. The test suite verifies the QR **payload contract** only against a *standalone* QR buffer it regenerates — it never decodes the QR **as actually embedded in the rendered PDF**. Two adjacent TODOs capture this:

- **line 43** — *"decodes a standalone QR buffer, not the one embedded in the PDF"*.
- **line 36** — *"strengthen to assert count=1 to verify pdf-lib dedup (single embedded image referenced by 14 drawImage calls per BR-026)"*.

This slice adds two assertions: decode the QR extracted **from the PDF**, and assert the QR image is embedded **exactly once**. It is the backlog item "#5 QR decode from embedded PDF" (tracked in `project_tech_debt` / `docs/superpowers/specs/2026-05-30-test-quality-bundle-r2-design.md` §"out of scope", excluded from that cleanup bundle because it needs real PDF parsing).

**Not** a product feature: there is no endpoint, no UI, no upload. It is purely a stronger unit test.

## Why

- The current test proves *"the URL we hand to the QR encoder is correct"*, but not *"the QR that ends up in the PDF a workshop prints is decodable and carries that URL"*. The embed→save→reload path (pdf-lib `embedPng`/`drawImage`/`save`) is unverified. A regression there (e.g. a pdf-lib upgrade changing image handling, a colorspace bug) would ship silently; only a physical print test would catch it.
- BR-026 (tag PDF immutable + single embedded image) implies the QR is embedded once and reused for all 14 labels. The "count=1" assertion pins that invariant so a future refactor that accidentally embeds per-label (14×, bloating the PDF) is caught.

## Scope

Single file changed: `packages/api/tests/unit/lib/vehicle-tag-renderer.test.ts`.

- **No production code change.** `src/lib/vehicle-tag-renderer.ts` untouched.
- **No new dependency.** `pdf-lib`, `jsqr`, `pngjs` are already deps; decompression uses Node built-in `node:zlib`.
- **No migration, no infra, no docs/BR change.**
- The existing standalone-payload test (lines 42-57) is **kept** as cheap belt-and-suspenders.

## Approach

A test-local helper (in the test file, or a small `tests/helpers/pdf-image.ts` if it reads cleaner) extracts the embedded QR image from the rendered PDF:

1. `PDFDocument.load(pdfBuffer)` → `pdf.context.enumerateIndirectObjects()` returns `[ref, obj]` pairs.
2. Select image XObjects: `obj` is a `PDFRawStream` whose dict `lookup(Subtype)` is `/Image`. The source QR PNG is RGBA, so pdf-lib stores it as a **DeviceRGB** image (`BitsPerComponent` 8) plus a grayscale **SMask** (the alpha). Choose the `DeviceRGB` stream (the QR pixels); ignore the `DeviceGray` SMask.
3. Read `Width`, `Height`, `BitsPerComponent`, `ColorSpace` from the dict. Decompress the stream contents with `zlib.inflateSync(stream.contents)` (Filter is `FlateDecode`) → raw `W×H×3` RGB samples.
4. Build a `W×H×4` `Uint8ClampedArray`: copy R,G,B per pixel, set A = 255.
5. `jsQR(rgba, W, H)` → assert non-null and `decoded.data === \`https://app.garageos.it/v/${SAMPLE}\``.

For the dedup assertion: count the DeviceRGB image XObjects of QR dimensions (≈256×256) across the indirect objects → expect exactly **1** (BR-026).

### Helper contract

`extractEmbeddedRgbImages(pdf: PDFDocument): Array<{ width: number; height: number; rgb: Buffer }>`
- Returns one entry per DeviceRGB image XObject (decompressed RGB samples).
- For the tag PDF this is length 1 (the QR). The decode test uses `[0]`; the dedup test asserts `length === 1`.
- Pure/synchronous given a loaded `PDFDocument`; no I/O.

This isolates the fiddly PDF-parsing in one named, testable unit and keeps the test bodies readable.

## Risk & mitigation

- **R1 — pdf-lib's exact image storage is the one unknown** (colorspace, bits-per-component, whether an SMask is split off, FlateDecode vs other filter). **Mitigation:** the first TDD step dumps the real XObject dict (`Subtype`/`ColorSpace`/`BitsPerComponent`/`Filter`/`Width`/`Height`) from a rendered sample, then the helper is written against the *actual* format observed — not assumptions. If pdf-lib stores something pathological (indexed colorspace, 1-bit, non-Flate filter), narrow the helper to that real format and document it; the slice stays test-only and never blocks.
- **R2 — jsQR sensitivity.** The QR is 256px with `margin:1`, error-correction `M` — ample for jsQR. If decode is flaky, the QR dimensions/margin are controlled by the renderer and unchanged; no mitigation expected to be needed.
- **R3 — multiple FlateDecode passes / predictors.** If pdf-lib applies a PNG predictor in the PDF filter, `inflateSync` alone won't reconstruct samples. **Mitigation:** observed during R1's dict dump (a `DecodeParms`/`Predictor` entry signals this); handle or document if present. Expected absent for pdf-lib's raw image streams.

## Testing

- Run locally while iterating: `pnpm --filter @garageos/api test -- vehicle-tag-renderer` (pure unit, no Docker).
- `pnpm -r typecheck` (pre-push gate). Full matrix on CI.
- Acceptance: (a) embedded-QR decode test passes and asserts the exact URL; (b) "embedded exactly once" test asserts count === 1; (c) existing standalone-payload test still green; (d) typecheck clean.

## Out of scope

- Rendering the PDF to a raster via pdfjs/canvas (heavier deps, overkill for a unit test).
- Any product feature that decodes a QR from a user-supplied PDF (upload/endpoint/UI) — that would be a separate spec, not this backlog item.
- The physical-print scannability check (line 44-45 note) — remains a manual/operator concern, unchanged.

## References

- Renderer: `packages/api/src/lib/vehicle-tag-renderer.ts` (QR via `qrcode`, embed via `pdf-lib`).
- Current test + TODOs: `packages/api/tests/unit/lib/vehicle-tag-renderer.test.ts:36,43`.
- Backlog origin: `docs/superpowers/specs/2026-05-30-test-quality-bundle-r2-design.md:22,68`; tech-debt ledger `project_tech_debt`.
- BR-022 (garage_code immutable) / BR-026 (tag PDF lazy + immutable, single embedded image).
