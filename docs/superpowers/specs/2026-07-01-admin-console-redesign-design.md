# Admin Console Redesign — Shell (shadcn inset sidebar) + content restyle

**Date:** 2026-07-01
**Scope:** `packages/admin-web` only. No API, DB, migration, business-rule, or error-code changes.
**Type:** Multi-PR frontend arc (2 PRs).

## Problem

The platform-admin console (`packages/admin-web`) is graphically bare. There is no
shared application shell: every page renders its own flat `min-h-screen p-8`
container and scatters navigation as inline `<Button>`s in its own header (see
`PlatformConsole.tsx` header: "Officine / Audit / Crea officina / Esci"). There
is no sidebar, no topbar, no consistent page framing, no dark mode. It does not
read as a professional admin dashboard.

By contrast, the officine app (`packages/web`) already has a mature shell
(`AppLayout` + `Sidebar`/`SidebarNav`/`TopBar` + mobile drawer + dark-mode
`ThemeToggle`). The admin console should reach a comparable — deliberately more
"dashboard template" — level of polish.

## Goals

- Give `admin-web` a real application shell: persistent sidebar navigation +
  topbar, replacing the per-page inline nav.
- Adopt the official **shadcn `sidebar` block**, **inset** variant, collapsible
  to an icon rail, with collapsed-state persistence (cookie).
- Add a light/dark theme system with a toggle in the topbar.
- Restyle page content (consistent page header, richer dashboard, cleaner
  tables / empty-states / error-states) so the whole console feels cohesive.
- Keep all existing behavior (auth, data fetching, mutations, dialogs) intact —
  this is a presentation-layer change.

## Non-goals

- No changes to API endpoints, DTOs, DB, RLS, business rules, or error codes.
- No global search in the topbar (only ~2 tenants; the officine search is
  domain-specific and not useful here).
- No new pages or features; no changes to routing *targets*, only to how routes
  are composed under a layout.
- Login / SetPassword are **not** placed inside the shell (they stay centered on
  a separate auth layout).

## Decisions (from brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Shell approach | **B — shadcn sidebar block** | User chose the "template dashboard" feel over porting the officine shell (approach A). Deliberately introduces a different shell paradigm from `packages/web`. |
| Layout variant | **Inset**, collapsible to icon rail | Content floats in a rounded inset card; most modern SaaS-dashboard look. |
| User menu | **Sidebar footer `NavUser`** | Canonical shadcn inset pattern: avatar-initials + name + email, dropdown with "Esci". |
| Dark mode | **Yes**, `ThemeToggle` in topbar | Port the theme system from `packages/web`; inset shell reads well in both themes. |
| Content scope | **Shell + content restyle** | User asked to push beyond the shell: consistent `PageHeader`, richer dashboard, curated tables/empty/error states. |

## Architecture

### Component tree (target)

```
App
└─ ThemeProvider
   └─ QueryClientProvider
      └─ AuthProvider
         └─ Routes
            ├─ /login          → Login          (AuthLayout, outside shell)
            ├─ /set-password   → SetPassword    (AuthLayout, outside shell)
            └─ ProtectedRoute
               └─ AppLayout                      (the shell)
                  └─ SidebarProvider
                     ├─ AppSidebar (variant="inset")
                     │  ├─ SidebarHeader   → brand "GarageOS Admin"
                     │  ├─ SidebarContent  → CTA "Crea officina" + NavMain
                     │  │                     (Dashboard / Officine / Audit)
                     │  └─ SidebarFooter   → NavUser (name/email + Esci dropdown)
                     └─ SidebarInset
                        ├─ Topbar (SidebarTrigger + PageHeader/breadcrumb + ThemeToggle)
                        └─ <Outlet/>   → page content
```

### Routing change

`App.tsx` moves protected routes under a single `AppLayout` element route that
renders `<Outlet/>`. Each page loses its own `min-h-screen p-8` wrapper and its
inline nav/sign-out buttons; it renders only its content (+ a `PageHeader`).
`ProtectedRoute` continues to gate unauthenticated access and wraps `AppLayout`.

### Theme system

Port `ThemeContext` / `ThemeToggle` / `useTheme` from `packages/web/src/theme`.
Add shadcn `--sidebar-*` CSS variables (light + `.dark`) to
`admin-web/src/globals.css` (neither globals file has them yet).

### New ui components (checked-in shadcn primitives)

`sidebar`, `dropdown-menu`, `tooltip`, `sheet` (mobile drawer), `skeleton`,
`separator`, `breadcrumb`. These mirror what `packages/web` already ships; they
are added manually (this repo hand-maintains `components/ui`, no CLI codegen).

### New dependencies (admin-web)

Standard shadcn radix primitives, already used in `packages/web`; justify in PR:

- `@radix-ui/react-tooltip` — collapsed icon-rail tooltips (required by `sidebar`).
- `@radix-ui/react-dropdown-menu` — `NavUser` menu (and reused elsewhere).
- `@radix-ui/react-separator` — sidebar/section separators.

(`sheet` reuses `@radix-ui/react-dialog`, already present. `NavUser` avatar uses
an initials `<div>`, so no `@radix-ui/react-avatar`.)

## PR breakdown

The full change (shadcn `sidebar.tsx` alone is ~700 lines, plus 6 other ui
primitives, the theme system, and restyling 5 in-shell screens + 2 auth screens)
will exceed the 1500-line hard limit. Split into two PRs:

### PR 1 — Shell foundation
- Add dependencies + ui components (sidebar, dropdown-menu, tooltip, sheet,
  skeleton, separator, breadcrumb).
- Add `--sidebar-*` tokens to `globals.css`.
- Port theme system + `ThemeToggle`.
- Build `AppLayout` (inset), `AppSidebar`, `NavMain`, `NavUser`, `Topbar`.
- Refactor `App.tsx` routing to compose protected pages under `AppLayout`;
  add `AuthLayout` for Login/SetPassword.
- **Minimal** page migration: strip each page's own header/nav wrapper so it
  renders correctly inside the shell (no content restyle yet).
- Tier-2 tests: shell renders nav + active state; NavUser dropdown → signOut;
  ThemeToggle flips theme; ProtectedRoute still gates; auth pages render outside
  shell.

### PR 2 — Content restyle
- `PageHeader` component (title + breadcrumb + optional action slot), applied to
  Dashboard / Officine / TenantDetail / CreateTenant / AuditLogs.
- Richer dashboard (stat cards + trend within the inset frame).
- Curated tables, empty-states, and error-states across pages.
- Tier-2 tests updated where conditional/data-gating logic changes; no
  pure-rendering tests.

## Testing

Frontend, so **Tier 2** (per CLAUDE.md "Test depth — two tiers"): 2-3 tests per
screen covering happy path, the error state, and any conditional logic that gates
data. No pure-rendering assertions. Existing tests are updated to match the new
composition (e.g. pages no longer own their header; nav moves to the shell).
JSDOM gotchas already catalogued for this repo apply (Radix pointer polyfills in
`tests/setup.ts`); shadcn `sidebar`/`dropdown`/`tooltip` need the same
`hasPointerCapture`/`scrollIntoView`/`ResizeObserver` polyfills — verify in PR1.

## Risks / notes

- **Two shell paradigms in the repo** (officine uses the hand-rolled shell; admin
  will use shadcn `SidebarProvider`). Accepted trade-off — user chose the
  template feel; the apps are independent bundles.
- **JSDOM polyfills**: the shadcn sidebar reads `window.matchMedia` (mobile
  detection) and Radix tooltip/dropdown need pointer-capture polyfills. Confirm
  `tests/setup.ts` covers them or extend it (Tier-1-adjacent test infra).
- **No visual regression tooling**: correctness is covered by Tier-2 tests; the
  *look* is validated by a browser smoke on prod after each PR (mandatory for
  shell/layout PRs per CLAUDE.md — smoke runbook is a ship-blocker).
- **Deploy**: admin-web ships via the "Deploy admin web asset" workflow / CDK S3
  sync; no infra change. Standard post-merge auto-deploy.

## Out of scope / deferred

- Officine `packages/web` shell is untouched (already has its own).
- Any new admin feature/page.
- Shared frontend package (`@garageos/shared`) for cross-app ui — still deferred
  tech-debt (`api-client`/`*-types` mirrors), not addressed here.
