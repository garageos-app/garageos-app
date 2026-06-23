# Mobile Brand Identity (Gauge-G) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the mobile app a real visual identity built on the chosen **Gauge-G** logo concept: a proper installable app icon (replacing the default Android icon), a branded splash screen, a redesigned "hero" login screen, and a brand lockup in the main tab headers.

**Architecture:** All four deliverables descend from a single source mark (`mark-01-gauge-g.svg`). App icon / adaptive icon / splash are wired through `app.config.js` (managed Expo workflow — `android/` is a gitignored prebuild artifact, so config drives EAS/dev-client builds). The in-app logo is rendered as a transparent `<Image>` from rasterized PNGs (white variant for dark/blue surfaces, blue variant for light surfaces) via one reusable `BrandLogo` component — **no `react-native-svg` runtime dependency**. The only new dependency is `expo-splash-screen` (first-party Expo module, required for a branded splash).

**Tech Stack:** Expo SDK 52, React Native 0.76, expo-router, `expo-splash-screen` config plugin, `<Image>` + static `require()`. Asset rasterization is a one-time authoring step using `sharp` installed in a throwaway temp dir (no repo dependency added).

**Spec:** No formal spec doc — medium/single-layer slice per `CLAUDE.md` § "Right-sizing". The brainstorming conversation (2026-06-23) is the design record.

**LOC budget:** ~300 net code lines + 3 binary PNG assets. Hard PR limit 1500. Check cumulative LOC after each task; halt and ask at ~80%.

---

## Source assets (already on disk)

From `C:\Users\Michele\Downloads\GarageOS logo design\assets\`, concept **01 gauge-g**:
- `icon-01-gauge-g-1024.png` — full app icon, gauge on blue `#1d4ed8` rounded square. Used **as-is** for the iOS/base icon.
- `mark-01-gauge-g.svg` — symbol only, blue strokes (`#1d4ed8` / accent `#3b82f6`) on transparent. The rasterization source for the white & blue in-app marks and the adaptive/splash foreground.

## Deviations from spec (verified against actual code — the code wins)

- The chosen "no exported wordmark / no exported dark-bg PNG" gap is intentional: the horizontal wordmark is composed in-app (mark + styled `<Text>`), and the dark/white variant is produced by recoloring the mark SVG strokes to `#FFFFFF`. Confirmed only `icon-*` and `mark-*` files exist on disk.
- `app.config.js` currently has **no** `icon`, `android.adaptiveIcon`, or splash config and **no** `expo-splash-screen` plugin — that is the root cause of the default Android icon and default splash. Verified at `packages/mobile/app.config.js:6-48`.

## Gotchas the implementer MUST respect (from project memory)

- **Icon/splash changes need a fresh build, not OTA.** They take effect only in a new dev-client / EAS build — smoke must run on a rebuilt app, not a reloaded JS bundle. ([[feedback_eas_build_monorepo_gotchas]])
- **Install Expo packages with `npx expo install expo-splash-screen`, never `pnpm add`** — the SDK pin must win. After install, run `npx expo install --fix` before smoke. ([[feedback_expo_sdk_install_fix_dep_drift]], [[feedback_pnpm_strict_expo_workspace]])
- **`require()` for image assets must be a static string literal** (Metro resolves at bundle time) — no dynamic/computed paths.
- **Do not use `absoluteFill` inside a `ScrollView`** — it collapses to 0×0 (white screen). If the login hero needs scroll for small screens, use a normal in-flow `ScrollView` with `contentContainerStyle`. ([[feedback_absolutefill_in_scrollview_collapses]])
- **Smoke is a BLOCKER** for this PR (shell/layout + device-facing). Re-assert `adb reverse tcp:8081` before suspecting code if the device looks stale. ([[feedback_smoke_mandatory_for_shell_layout_pr]], [[feedback_adb_reverse_drops_stale_bundle]])
- Comments in English; the only user-facing string added is the Italian tagline.

## Branch

`feat/mobile-brand-identity` (from updated `main`).

---

### Task 1: Brand assets + app icon, adaptive icon, splash

Generate the in-app + native brand assets and wire them into `app.config.js`. This is config + binary assets; there is no unit test (Expo config is validated at build/smoke).

**Files:**
- Create: `packages/mobile/assets/icon.png` (copy of `icon-01-gauge-g-1024.png`, 1024×1024)
- Create: `packages/mobile/assets/icon-mark-white.png` (1024×1024, transparent, white gauge mark centered at ~60% with safe-zone padding)
- Create: `packages/mobile/assets/icon-mark-blue.png` (1024×1024, transparent, blue gauge mark same geometry)
- Modify: `packages/mobile/app.config.js`
- Modify: `packages/mobile/package.json` (adds `expo-splash-screen` via `expo install`)

**Asset generation (one-time authoring, not committed tooling):**
- [ ] **Step 1: Build the recolored mark SVGs.** From `mark-01-gauge-g.svg`, produce a white variant (all `stroke`/`fill` → `#FFFFFF`) and keep a blue variant (original colors). Wrap each in a 1024 viewBox with the symbol scaled to ~60% and centered (leaves the Android adaptive-icon safe zone).
- [ ] **Step 2: Rasterize via throwaway sharp.** In a temp dir outside the repo (e.g. `$env:TEMP\garageos-raster`), `npm init -y && npm i sharp`, then a small Node script rasterizes both SVGs → `icon-mark-white.png` / `icon-mark-blue.png` (1024×1024) and writes them into `packages/mobile/assets/`. Copy `icon-01-gauge-g-1024.png` → `packages/mobile/assets/icon.png`. Delete the temp dir. (Result committed = PNGs only; repo `package.json` unchanged by this step.)
- [ ] **Step 3: Verify** the three PNGs exist, are 1024×1024, and the mark PNGs have transparent backgrounds (`Get-Item` size sanity + open one to confirm).

**Config wiring (`app.config.js`):**
- [ ] **Step 4: Add icon + adaptive icon.** Set `expo.icon: './assets/icon.png'`. Add `android.adaptiveIcon: { foregroundImage: './assets/icon-mark-white.png', backgroundColor: '#1d4ed8' }`.
- [ ] **Step 5: Install + wire splash.** `npx expo install expo-splash-screen`. Add to `plugins`:
  ```js
  ['expo-splash-screen', {
    image: './assets/icon-mark-white.png',
    backgroundColor: '#1d4ed8',
    imageWidth: 200,
  }]
  ```
- [ ] **Step 6: Typecheck + config sanity.** `pnpm --filter @garageos/mobile typecheck` (config is JS but catches nothing here) and `npx expo config --type public` to confirm the merged config resolves icon/splash/adaptiveIcon without error.
- [ ] **Step 7: Commit.**
  ```bash
  git add packages/mobile/assets packages/mobile/app.config.js packages/mobile/package.json pnpm-lock.yaml
  git commit -m "feat(mobile): brand assets + app icon, adaptive icon, splash"
  ```

**Note for PR description:** new dependency `expo-splash-screen` — first-party Expo module, required for a branded splash; zero net-new third-party deps.

---

### Task 2: Brand color + `BrandLogo` component

A single presentational lockup (mark `<Image>` + optional "GarageOS" wordmark + optional tagline), tone-aware so it works on both the blue hero band and the white header.

**Files:**
- Modify: `packages/mobile/src/theme/colors.ts` (add `brand`)
- Create: `packages/mobile/src/components/BrandLogo.tsx`
- Test: `packages/mobile/tests/components/BrandLogo.test.tsx`

**Interfaces:**
- Produces: `BrandLogo` (default or named export) with props
  `{ tone: 'onLight' | 'onDark'; size?: number; showWordmark?: boolean; tagline?: string }`.
  `tone` selects the mark PNG (`onDark` → `icon-mark-white.png`, `onLight` → `icon-mark-blue.png`) and the text color (`onDark` → white, `onLight` → `colors.fg`). `size` is the mark square in px (default 40). Wordmark renders the literal text `GarageOS`; tagline renders below it when provided.
- Consumes: `colors` from `@/theme/colors`.

**Theme:**
- [ ] **Step 1: Add brand color.** In `colors.ts` add `brand: '#1d4ed8'` (matches icon/splash/adaptive). Leave `primary: '#0066CC'` unchanged — it stays the interactive/control color; `brand` is the brand-surface color (hero band, splash bg).

**Component (TDD — UI, implement-then-test per Tier 2):**
- [ ] **Step 2: Implement `BrandLogo`.** `<View>` row/column: `<Image source={require('../../assets/icon-mark-white.png')} />` or the blue one chosen by `tone` (two static `require`s, picked at render — keep both requires at module top, select by tone). Wordmark `<Text>GarageOS</Text>` (fontWeight `'700'`, letterSpacing `-0.5`, color by tone). Optional tagline `<Text>` (smaller, muted/white-80%). Mark sized by `size`.
- [ ] **Step 3: Write tests** (`tests/components/BrandLogo.test.tsx`, mirror `GoogleSignInButton.test.tsx` style):
  - renders the `GarageOS` wordmark text when `showWordmark` (default true).
  - renders the tagline text when `tagline` is provided, and not otherwise.
- [ ] **Step 4: Run tests.** `pnpm --filter @garageos/mobile test -- BrandLogo` → PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/mobile/src/theme/colors.ts packages/mobile/src/components/BrandLogo.tsx packages/mobile/tests/components/BrandLogo.test.tsx
  git commit -m "feat(mobile): brand color and BrandLogo component"
  ```

---

### Task 3: Redesign login with hero brand layout

Replace the bare centered form with a hero band (blue `colors.brand`, full-bleed under the status bar) carrying the large white logo + wordmark + tagline, over a clean form section. **All existing logic is preserved**: email/password validation, reset/error banners, `?googleError=1` param banner, deferred `?claimCode` navigation, Google sign-in.

**Files:**
- Modify: `packages/mobile/app/login.tsx`
- Test: `packages/mobile/tests/screens/login.test.tsx` (new)

**Layout contract:**
- Hero band: background `colors.brand`, top padding = `useSafeAreaInsets().top` (band bleeds into the status-bar area), centered `<BrandLogo tone="onDark" size={72} showWordmark tagline="Il libretto digitale del tuo veicolo" />`.
- `<StatusBar style="light" />` on this screen (white status-bar content over the blue band).
- Form section below on `colors.bg`: the existing email field, password field, "Accedi" submit, "oppure" divider, `GoogleSignInButton`, and the two link rows — unchanged in behavior, restyled to sit in the lower section. If vertical space is tight with the keyboard, wrap the form in a `ScrollView` (`keyboardShouldPersistTaps="handled"`) — **not** `absoluteFill`.
- Keep `KeyboardAvoidingView` behavior (`padding` iOS / `height` Android).
- The success banner (`justReset`) and error banner (`displayError`) keep their current logic and Italian copy.

**Steps:**
- [ ] **Step 1: Restructure the screen.** Split into a hero `<View>` (brand) and a form `<View>`/`<ScrollView>`; move the existing fields/buttons into the form section. Add `useSafeAreaInsets` and `<StatusBar style="light" />`. Remove the inline `logo`/`logoText`/`wordmark` styles now superseded by `BrandLogo`.
- [ ] **Step 2: Write screen tests** (`tests/screens/login.test.tsx`, mirror `profile-logout-push.test.tsx`: mock `@/auth/useAuth` and `expo-router`):
  - **Brand present:** renders the `GarageOS` wordmark and the tagline `Il libretto digitale del tuo veicolo`.
  - **Validation gates submit:** pressing `Accedi` with empty email shows `Email obbligatoria` and does **not** call `signIn`.
  - **Happy path:** with valid email + password, pressing `Accedi` calls `signIn(email, password)` then `router.replace('/(tabs)')`.
  - **Google error banner:** rendering with `useLocalSearchParams` → `{ googleError: '1' }` shows the mapped Google error message. (Mock `expo-router`'s `useLocalSearchParams` accordingly.)
- [ ] **Step 3: Run tests.** `pnpm --filter @garageos/mobile test -- login` → PASS.
- [ ] **Step 4: Typecheck.** `pnpm --filter @garageos/mobile typecheck` → clean.
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/mobile/app/login.tsx packages/mobile/tests/screens/login.test.tsx
  git commit -m "feat(mobile): redesign login with hero brand layout"
  ```

---

### Task 4: Brand lockup in main tab headers

Give the three primary tabs (Veicoli / Scadenze / Profilo) a brand identity in the navigation header by replacing the text title with a small `BrandLogo` lockup. Detail screens keep their contextual titles (untouched).

**Files:**
- Modify: `packages/mobile/app/(tabs)/_layout.tsx`

**Contract:**
- Add a shared `headerTitle: () => <BrandLogo tone="onLight" size={24} showWordmark />` to the three visible `Tabs.Screen` options (index, deadlines, profile), via a small local helper to stay DRY. Keep each screen's `tabBarLabel`/`tabBarIcon` and the `index` `headerRight` "add vehicle" button unchanged. `vehicles/[id]` (`href: null`) is untouched.
- `headerTitleAlign: 'center'` is acceptable; match platform default if it looks off in smoke.

**Steps:**
- [ ] **Step 1: Wire the header.** Import `BrandLogo`; add the `headerTitle` render prop to the three `Tabs.Screen` options. Keep `headerShown: true`.
- [ ] **Step 2: Typecheck.** `pnpm --filter @garageos/mobile typecheck` → clean. (No unit test — header is navigator config; covered by the BrandLogo test + smoke.)
- [ ] **Step 3: Commit.**
  ```bash
  git add packages/mobile/app/(tabs)/_layout.tsx
  git commit -m "feat(mobile): show brand logo in main tab headers"
  ```

---

## Review gates (in order)

1. `pnpm -r typecheck` (pre-push hook) — mandatory local gate.
2. **Final whole-branch `/code-review` (high effort)** — load-bearing.
3. CI full matrix (`gh pr checks --watch`).
4. **Smoke runbook on a freshly built dev-client/EAS app (BLOCKER):** new app icon visible on the launcher; branded splash on cold start (no default Expo screen); redesigned login hero renders correctly with status bar light over the blue band; brand lockup shows in the three tab headers; existing login flows (password, Google, validation, reset banner) still work.

## Self-review

- **Spec coverage:** point 1 (install icon) → Task 1 icon/adaptiveIcon; point 2 (login) → Task 3; point 3 (splash) → Task 1 splash; point 4 (in-app brand element) → Task 4 + Task 2 component. ✔ all four covered.
- **Type consistency:** `BrandLogo` prop shape (`tone`/`size`/`showWordmark`/`tagline`) is identical across Task 2 (definition), Task 3, and Task 4 (consumers). `colors.brand` added in Task 2, consumed in Task 3. ✔
- **Placeholders:** none — every step has a concrete action, exact path, or exact command. ✔
