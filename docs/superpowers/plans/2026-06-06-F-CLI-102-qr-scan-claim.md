# F-CLI-102 QR scan claim — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add QR-code scanning to the mobile vehicle-claim flow: the customer scans the QR on the vehicle tag, the code is extracted and pre-fills the existing claim form for confirmation.

**Architecture:** Mobile-only, additive. Reuses the claim endpoint (#159) and `ClaimVehicleForm`/`useClaimVehicle`/`claim-vehicle.tsx` (#160) unchanged in flow. Adds (1) `expo-camera`, (2) a pure `extractGarageCode` helper that parses the tag URL `https://app.garageos.it/v/GO-482-KXRT` (or a bare code) and validates it against the existing regex, (3) a `QrScanner` component encapsulating all camera/permission logic, (4) a "Scansiona QR" button + inline full-screen scanner overlay inside `ClaimVehicleForm` that, on a valid scan, sets the code field. The customer then taps "Aggiungi" — the existing confirm/navigation flow.

**Tech Stack:** Expo SDK 52, React Native 0.76, expo-camera (`CameraView` + `useCameraPermissions`), Jest + @testing-library/react-native.

**Spec:** `docs/superpowers/specs/2026-06-06-F-CLI-102-qr-scan-claim-design.md`

---

## File Structure

- **Create** `packages/mobile/src/lib/qr.ts` — pure `extractGarageCode(raw): string | null`.
- **Create** `packages/mobile/tests/lib/qr.test.ts` — unit tests for the helper.
- **Create** `packages/mobile/src/components/QrScanner.tsx` — camera/permission/scan component.
- **Create** `packages/mobile/tests/components/QrScanner.test.tsx` — component tests (expo-camera mocked).
- **Modify** `packages/mobile/src/lib/validators/claimVehicle.ts` — export `GARAGE_CODE_RE`.
- **Modify** `packages/mobile/src/components/ClaimVehicleForm.tsx` — "Scansiona QR" button + scanner overlay.
- **Modify** `packages/mobile/tests/components/ClaimVehicleForm.test.tsx` — wiring test (QrScanner mocked).
- **Modify** `packages/mobile/package.json` — add `expo-camera` (via `expo install`).
- **Modify** `packages/mobile/app.json` — register the `expo-camera` config plugin.

### Test execution note (mobile jest)

Jest runs get auto-backgrounded and the output file lags. Use the reliable pattern:
redirect to a controlled file + `echo "__EXIT $?__"` + poll with `grep -q __EXIT`. Example:

```bash
cd packages/mobile && (pnpm jest tests/lib/qr.test.ts > /tmp/qr.out 2>&1; echo "__EXIT $?__" >> /tmp/qr.out) ; \
  while ! grep -q __EXIT /tmp/qr.out; do sleep 2; done ; cat /tmp/qr.out
```

(Adjust the test path per task. On Windows use the Bash tool with a writable temp path.)

---

## Task 1: Add expo-camera dependency + config plugin

No test (infra). This is the first non-purely-additive mobile dependency — justify in the PR
description (official Expo SDK module, listed in the spec's tech stack, bundled in Expo Go so
smoke via sideload still works, no dev build needed).

**Files:**
- Modify: `packages/mobile/package.json` (via `expo install`)
- Modify: `packages/mobile/app.json:17`

- [ ] **Step 1: Install expo-camera SDK-matched**

Run (from `packages/mobile`):

```bash
cd packages/mobile && pnpm expo install expo-camera
```

`expo install` pins the version compatible with SDK 52 (expected `~16.0.x`). Do NOT use
`pnpm add expo-camera` (would pull an arbitrary version — SDK drift, lesson #100).

- [ ] **Step 2: Verify the pinned version**

Run: `cd packages/mobile && node -e "console.log(require('./package.json').dependencies['expo-camera'])"`
Expected: a `~16.0.x` range string is printed (SDK-52 compatible). If it is not in the 16.0.x
range, stop and reconcile against `expo install --check`.

- [ ] **Step 3: Register the config plugin in app.json**

In `packages/mobile/app.json`, replace the `plugins` array:

```jsonc
"plugins": [
  "expo-router",
  "expo-secure-store",
  [
    "expo-camera",
    {
      "cameraPermission": "Consenti a GarageOS di usare la camera per scansionare il QR del tag veicolo."
    }
  ]
],
```

(Needed for future standalone builds; in Expo Go the permission is requested at runtime.)

- [ ] **Step 4: Typecheck still passes**

Run: `pnpm --filter @garageos/mobile typecheck`
Expected: no errors (the dep adds types; nothing references it yet).

- [ ] **Step 5: Commit**

```bash
git add packages/mobile/package.json packages/mobile/app.json pnpm-lock.yaml
git commit -F - <<'EOF'
feat(mobile): add expo-camera dependency for QR scan (F-CLI-102)

First non-additive mobile dep. Official Expo SDK module, bundled in
Expo Go (smoke via sideload unaffected). Registers the camera config
plugin with an Italian permission string for future standalone builds.
EOF
```

---

## Task 2: `extractGarageCode` helper + export the regex

**Files:**
- Modify: `packages/mobile/src/lib/validators/claimVehicle.ts:6`
- Create: `packages/mobile/src/lib/qr.ts`
- Create: `packages/mobile/tests/lib/qr.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/mobile/tests/lib/qr.test.ts`:

```ts
import { extractGarageCode } from '@/lib/qr';

describe('extractGarageCode', () => {
  it('extracts the code from the tag URL', () => {
    expect(extractGarageCode('https://app.garageos.it/v/GO-482-KXRT')).toBe('GO-482-KXRT');
  });

  it('handles a trailing slash and a query string', () => {
    expect(extractGarageCode('https://app.garageos.it/v/GO-482-KXRT/')).toBe('GO-482-KXRT');
    expect(extractGarageCode('https://app.garageos.it/v/GO-482-KXRT?utm=tag')).toBe('GO-482-KXRT');
  });

  it('accepts a bare code', () => {
    expect(extractGarageCode('GO-482-KXRT')).toBe('GO-482-KXRT');
  });

  it('normalizes to uppercase', () => {
    expect(extractGarageCode('go-482-kxrt')).toBe('GO-482-KXRT');
    expect(extractGarageCode('  https://app.garageos.it/v/go-482-kxrt ')).toBe('GO-482-KXRT');
  });

  it('returns null for an unrelated URL or junk', () => {
    expect(extractGarageCode('https://example.com/promo')).toBeNull();
    expect(extractGarageCode('hello world')).toBeNull();
    expect(extractGarageCode('')).toBeNull();
  });

  it('returns null for codes failing BR-020 (forbidden digits/letters)', () => {
    expect(extractGarageCode('GO-100-ABCD')).toBeNull(); // digit 1 not allowed
    expect(extractGarageCode('GO-234-ABIO')).toBeNull(); // I/O not allowed
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (mobile jest pattern above): `pnpm jest tests/lib/qr.test.ts`
Expected: FAIL — `Cannot find module '@/lib/qr'`.

- [ ] **Step 3: Export the regex from the validator**

In `packages/mobile/src/lib/validators/claimVehicle.ts`, change line 6 from:

```ts
const GARAGE_CODE_RE = /^GO-[2-9]{3}-[A-HJ-NPRTV-Z]{4}$/;
```

to:

```ts
export const GARAGE_CODE_RE = /^GO-[2-9]{3}-[A-HJ-NPRTV-Z]{4}$/;
```

- [ ] **Step 4: Write the helper**

Create `packages/mobile/src/lib/qr.ts`:

```ts
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm jest tests/lib/qr.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Confirm the validator's own tests still pass**

Run: `pnpm jest tests/lib/validators/claimVehicle.test.ts`
Expected: PASS (exporting the const changes nothing for existing consumers).

- [ ] **Step 7: Commit**

```bash
git add packages/mobile/src/lib/qr.ts packages/mobile/tests/lib/qr.test.ts packages/mobile/src/lib/validators/claimVehicle.ts
git commit -F - <<'EOF'
feat(mobile): extractGarageCode QR parser (F-CLI-102)

Pure helper that pulls the GarageOS code out of the tag URL (or a bare
code) and validates it against the shared BR-020 regex (now exported
from the claim validator).
EOF
```

---

## Task 3: `QrScanner` component

Encapsulates camera permission + scanning. `expo-camera` is mocked in the test (jest-expo
provides no useful default mock — same approach as the datetimepicker mock in
`tests/components/PrivateInterventionForm.test.tsx`).

**Files:**
- Create: `packages/mobile/src/components/QrScanner.tsx`
- Create: `packages/mobile/tests/components/QrScanner.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `packages/mobile/tests/components/QrScanner.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react-native';
import { QrScanner } from '@/components/QrScanner';

// Controllable mocks for expo-camera. `mockPermission` / `mockRequest` drive the
// permission state; `mockScanData` is the payload the mocked CameraView emits on
// press (so a test press simulates a barcode read).
let mockPermission: { granted: boolean; canAskAgain: boolean } | null = null;
let mockRequest = jest.fn();
let mockScanData = '';

jest.mock('expo-camera', () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const React = require('react');
  const { Pressable, Text } = require('react-native');
  /* eslint-enable @typescript-eslint/no-require-imports */
  return {
    __esModule: true,
    useCameraPermissions: () => [mockPermission, mockRequest],
    CameraView: ({ onBarcodeScanned }: { onBarcodeScanned?: (e: { data: string }) => void }) =>
      React.createElement(
        Pressable,
        { testID: 'mock-camera', onPress: () => onBarcodeScanned?.({ data: mockScanData }) },
        React.createElement(Text, null, 'camera'),
      ),
  };
});

beforeEach(() => {
  mockPermission = null;
  mockRequest = jest.fn();
  mockScanData = '';
});

describe('QrScanner', () => {
  it('asks for permission when undetermined', () => {
    mockPermission = { granted: false, canAskAgain: true };
    render(<QrScanner onScanned={jest.fn()} onCancel={jest.fn()} />);
    fireEvent.press(screen.getByRole('button', { name: 'Consenti accesso camera' }));
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('shows the manual fallback when permission is denied for good', () => {
    mockPermission = { granted: false, canAskAgain: false };
    render(<QrScanner onScanned={jest.fn()} onCancel={jest.fn()} />);
    expect(screen.getByText(/Permesso camera negato/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Apri impostazioni' })).toBeOnTheScreen();
  });

  it('renders the camera when granted', () => {
    mockPermission = { granted: true, canAskAgain: false };
    render(<QrScanner onScanned={jest.fn()} onCancel={jest.fn()} />);
    expect(screen.getByTestId('mock-camera')).toBeOnTheScreen();
  });

  it('calls onScanned with the extracted code on a valid QR', () => {
    mockPermission = { granted: true, canAskAgain: false };
    mockScanData = 'https://app.garageos.it/v/GO-234-ABCD';
    const onScanned = jest.fn();
    render(<QrScanner onScanned={onScanned} onCancel={jest.fn()} />);
    fireEvent.press(screen.getByTestId('mock-camera'));
    expect(onScanned).toHaveBeenCalledWith('GO-234-ABCD');
  });

  it('shows "QR non riconosciuto" and does not call onScanned on an invalid QR', () => {
    mockPermission = { granted: true, canAskAgain: false };
    mockScanData = 'https://example.com';
    const onScanned = jest.fn();
    render(<QrScanner onScanned={onScanned} onCancel={jest.fn()} />);
    fireEvent.press(screen.getByTestId('mock-camera'));
    expect(screen.getByText('QR non riconosciuto')).toBeOnTheScreen();
    expect(onScanned).not.toHaveBeenCalled();
  });

  it('ignores a second valid scan (one-shot guard)', () => {
    mockPermission = { granted: true, canAskAgain: false };
    mockScanData = 'https://app.garageos.it/v/GO-234-ABCD';
    const onScanned = jest.fn();
    render(<QrScanner onScanned={onScanned} onCancel={jest.fn()} />);
    fireEvent.press(screen.getByTestId('mock-camera'));
    fireEvent.press(screen.getByTestId('mock-camera'));
    expect(onScanned).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel from the camera overlay', () => {
    mockPermission = { granted: true, canAskAgain: false };
    const onCancel = jest.fn();
    render(<QrScanner onScanned={jest.fn()} onCancel={onCancel} />);
    fireEvent.press(screen.getByRole('button', { name: 'Annulla' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm jest tests/components/QrScanner.test.tsx`
Expected: FAIL — `Cannot find module '@/components/QrScanner'`.

- [ ] **Step 3: Write the component**

Create `packages/mobile/src/components/QrScanner.tsx`:

```tsx
import { useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { extractGarageCode } from '@/lib/qr';
import { colors, spacing } from '@/theme/colors';

type Props = { onScanned: (code: string) => void; onCancel: () => void };

export function QrScanner({ onScanned, onCancel }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const [hint, setHint] = useState<string | null>(null);
  // onBarcodeScanned fires on every frame the QR is in view; guard so we hand a
  // valid code to the parent exactly once.
  const handledRef = useRef(false);

  function handleBarcodeScanned({ data }: { data: string }) {
    if (handledRef.current) return;
    const code = extractGarageCode(data);
    if (code) {
      handledRef.current = true;
      onScanned(code);
    } else {
      setHint('QR non riconosciuto');
    }
  }

  if (!permission) {
    return (
      <View style={[StyleSheet.absoluteFill, styles.centered]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (!permission.granted && permission.canAskAgain) {
    return (
      <View style={[StyleSheet.absoluteFill, styles.centered]}>
        <Text style={styles.message}>Per scansionare il QR serve l'accesso alla camera.</Text>
        <Pressable onPress={requestPermission} accessibilityRole="button" style={styles.action}>
          <Text style={styles.actionText}>Consenti accesso camera</Text>
        </Pressable>
        <Pressable onPress={onCancel} accessibilityRole="button" style={styles.cancel}>
          <Text style={styles.cancelText}>Annulla</Text>
        </Pressable>
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={[StyleSheet.absoluteFill, styles.centered]}>
        <Text style={styles.message}>
          Permesso camera negato. Inserisci il codice manualmente.
        </Text>
        <Pressable
          onPress={() => Linking.openSettings()}
          accessibilityRole="button"
          style={styles.action}
        >
          <Text style={styles.actionText}>Apri impostazioni</Text>
        </Pressable>
        <Pressable onPress={onCancel} accessibilityRole="button" style={styles.cancel}>
          <Text style={styles.cancelText}>Annulla</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={StyleSheet.absoluteFill}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={handleBarcodeScanned}
      />
      <View style={styles.overlay} pointerEvents="box-none">
        <View style={styles.frame} />
        <Text style={styles.scanHint}>Inquadra il QR sul tag del veicolo</Text>
        {hint ? <Text style={styles.scanError}>{hint}</Text> : null}
        <Pressable onPress={onCancel} accessibilityRole="button" style={styles.cancel}>
          <Text style={styles.cancelText}>Annulla</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    backgroundColor: colors.bg,
  },
  message: { color: colors.fg, fontSize: 15, textAlign: 'center' },
  action: {
    backgroundColor: colors.primary,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: 8,
    alignItems: 'center',
  },
  actionText: { color: colors.primaryFg, fontSize: 16, fontWeight: '600' },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
  },
  frame: {
    width: 220,
    height: 220,
    borderWidth: 3,
    borderColor: colors.primaryFg,
    borderRadius: 16,
    backgroundColor: 'transparent',
  },
  scanHint: { color: colors.primaryFg, fontSize: 15, fontWeight: '600' },
  scanError: { color: colors.danger, fontSize: 14, fontWeight: '600' },
  cancel: { alignItems: 'center', padding: spacing.sm },
  cancelText: { color: colors.primary, fontSize: 14 },
});
```

Note: the `denied` overlay and the `granted` overlay both render a "Annulla" button — the
"calls onCancel from the camera overlay" test uses `granted`, so the regex `name: 'Annulla'`
resolves to a single button in that render.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm jest tests/components/QrScanner.test.tsx`
Expected: PASS (all 7 cases).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @garageos/mobile typecheck`
Expected: no errors. (If `colors.primaryFg`/`spacing.lg` etc. don't exist, reconcile against
`src/theme/colors.ts` — the same tokens are used by `ClaimVehicleForm.tsx`.)

- [ ] **Step 6: Commit**

```bash
git add packages/mobile/src/components/QrScanner.tsx packages/mobile/tests/components/QrScanner.test.tsx
git commit -F - <<'EOF'
feat(mobile): QrScanner component for vehicle claim (F-CLI-102)

Camera + permission states (undetermined/granted/denied), QR decode via
extractGarageCode, one-shot guard, manual-entry fallback on denial.
EOF
```

---

## Task 4: Wire "Scansiona QR" + scanner overlay into ClaimVehicleForm

**Files:**
- Modify: `packages/mobile/src/components/ClaimVehicleForm.tsx`
- Modify: `packages/mobile/tests/components/ClaimVehicleForm.test.tsx`

- [ ] **Step 1: Write the failing test**

Add to the top of `packages/mobile/tests/components/ClaimVehicleForm.test.tsx` (after the
existing imports), a mock of `QrScanner` that immediately exposes a "scan" button:

```tsx
// Mock the camera component: a stub button that, when pressed, emits a valid code
// as if a QR had been scanned. Keeps the form test free of expo-camera.
jest.mock('@/components/QrScanner', () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const React = require('react');
  const { Pressable, Text } = require('react-native');
  /* eslint-enable @typescript-eslint/no-require-imports */
  return {
    QrScanner: ({ onScanned }: { onScanned: (code: string) => void }) =>
      React.createElement(
        Pressable,
        { testID: 'scanner-stub', onPress: () => onScanned('GO-234-ABCD') },
        React.createElement(Text, null, 'scanner'),
      ),
  };
});
```

Then add these two tests inside the `describe('ClaimVehicleForm', …)` block:

```tsx
it('opens the scanner when "Scansiona QR" is tapped', () => {
  render(<ClaimVehicleForm onSubmit={jest.fn()} onCancel={jest.fn()} />);
  fireEvent.press(screen.getByRole('button', { name: 'Scansiona QR' }));
  expect(screen.getByTestId('scanner-stub')).toBeOnTheScreen();
});

it('pre-fills the code field from a scanned QR', async () => {
  render(<ClaimVehicleForm onSubmit={jest.fn()} onCancel={jest.fn()} />);
  fireEvent.press(screen.getByRole('button', { name: 'Scansiona QR' }));
  fireEvent.press(screen.getByTestId('scanner-stub'));
  await waitFor(() =>
    expect(screen.getByPlaceholderText('GO-NNN-AAAA').props.value).toBe('GO-234-ABCD'),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm jest tests/components/ClaimVehicleForm.test.tsx`
Expected: FAIL — no button named "Scansiona QR".

- [ ] **Step 3: Wire the scanner into the form**

In `packages/mobile/src/components/ClaimVehicleForm.tsx`:

(a) Add imports near the top:

```tsx
import { Ionicons } from '@expo/vector-icons';
import { QrScanner } from '@/components/QrScanner';
```

(b) Add a state flag next to the other `useState` hooks:

```tsx
const [showScanner, setShowScanner] = useState(false);
```

(c) Add the handler (after `handleSubmit`):

```tsx
function handleScanned(code: string) {
  setCode(code);
  setShowScanner(false);
  setFieldError(undefined);
  setBanner(null);
}
```

(d) At the very start of the returned JSX, short-circuit to the scanner overlay when active.
Change:

```tsx
  return (
    <View style={styles.container}>
```

to:

```tsx
  if (showScanner) {
    return <QrScanner onScanned={handleScanned} onCancel={() => setShowScanner(false)} />;
  }

  return (
    <View style={styles.container}>
```

(e) Add the "Scansiona QR" button inside the `field` View, right after the hint `Text` and
before the `fieldError` line:

```tsx
        <Pressable
          onPress={() => setShowScanner(true)}
          accessibilityRole="button"
          disabled={submitting}
          style={styles.scanButton}
        >
          <Ionicons name="qr-code-outline" size={18} color={colors.primary} />
          <Text style={styles.scanButtonText}>Scansiona QR</Text>
        </Pressable>
```

(f) Add the two styles to the `StyleSheet.create({ … })` object:

```tsx
  scanButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
  },
  scanButtonText: { color: colors.primary, fontSize: 14, fontWeight: '600' },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm jest tests/components/ClaimVehicleForm.test.tsx`
Expected: PASS — both new tests pass and all six pre-existing tests stay green.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @garageos/mobile typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/mobile/src/components/ClaimVehicleForm.tsx packages/mobile/tests/components/ClaimVehicleForm.test.tsx
git commit -F - <<'EOF'
feat(mobile): wire QR scan into ClaimVehicleForm (F-CLI-102)

Adds a "Scansiona QR" button that opens the inline scanner overlay; a
valid scan pre-fills the code field for the existing confirm flow.
EOF
```

---

## Task 5: Full mobile suite + repo typecheck

**Files:** none (verification).

- [ ] **Step 1: Run the full mobile test suite**

Run (mobile jest pattern with poll): `cd packages/mobile && pnpm jest`
Expected: all suites pass. Note the new counts (was 39 suites / 255 tests at #160; this adds
3 files — qr, QrScanner — and tests in ClaimVehicleForm). Record the new totals for the PR.

- [ ] **Step 2: Repo-wide typecheck**

Run: `pnpm -r typecheck`
Expected: clean across all packages.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/mobile-qr-scan-claim
```

Open the PR (title `feat(mobile): QR scan vehicle claim (F-CLI-102)`). In the description:
- **What/Why:** F-CLI-102 — scan the tag QR to pre-fill the claim code; reuses #159 endpoint
  and #160 form.
- **Dependency justification:** `expo-camera` is the first non-additive mobile dep — official
  Expo SDK module, in the spec's tech stack, bundled in Expo Go (smoke unaffected).
- **Doc divergence:** spec lists `expo-barcode-scanner` (deprecated) — used `expo-camera`
  `CameraView` instead. Note it in the PR.
- **Smoke (device, post-merge, non-blocking):** grant camera → scan a QR with
  `https://app.garageos.it/v/<code>` → field pre-filled → "Aggiungi" → detail; deny permission
  → manual fallback; scan an unrelated QR → "QR non riconosciuto".

- [ ] **Step 4: Watch CI**

Run: `gh pr checks --watch`
Expected: all green. If red, fix and push a follow-up commit.

---

## Self-review

- **Spec coverage:** dependency + app.json plugin (Task 1) ✓; `extractGarageCode` URL/bare/
  invalid + regex export (Task 2) ✓; `QrScanner` permission states + one-shot + decode +
  fallback (Task 3) ✓; "Scansiona QR" button + inline overlay + pre-fill confirm (Task 4) ✓;
  IT strings embedded in the component ✓; testing plan mapped to Tasks 2–4 ✓; out-of-scope
  (deep-link, QR generation, backend) untouched ✓.
- **Placeholder scan:** no TBD/TODO; every code step shows full code.
- **Type consistency:** `extractGarageCode(raw): string | null`, `GARAGE_CODE_RE` (exported),
  `QrScanner` props `{ onScanned: (code: string) => void; onCancel: () => void }`, and the
  `handleScanned(code: string)` wiring all match across Tasks 2–4. `onBarcodeScanned` payload
  typed `{ data: string }` consistently in mock and component.
- **Theme tokens:** `colors.{primary,primaryFg,bg,fg,muted,danger,border}` and `spacing.{xs,sm,md,lg}`
  are the same tokens already used by `ClaimVehicleForm.tsx` — Task 3 Step 5 / Task 4 Step 5
  reconcile if any differ.
