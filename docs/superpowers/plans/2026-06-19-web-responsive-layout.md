# Web Responsive Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the officine web app usable without horizontal overflow on phones/tablets-in-portrait and more readable on 14" laptops, without building dedicated mobile UI.

**Architecture:** Three independent levers. (1) A fluid root `font-size` (`clamp`) scales all rem-based type/spacing up on laptops with a cap for large monitors. (2) The app shell (`AppLayout` + `Sidebar` + `TopBar`) becomes responsive: below `lg` (1024px) the fixed 220px sidebar is replaced by a left slide-over drawer opened from a hamburger, and the TopBar search collapses behind an icon. (3) A targeted reflow sweep fixes the few full-page views that still overflow (fixed multi-column grids, `p-8` padding, non-wrapping action button clusters).

**Tech Stack:** React 19 + Vite + Tailwind v3 + shadcn/ui (Radix). Tests: Vitest + Testing Library (JSDOM). The drawer is built on the existing `@radix-ui/react-dialog` (already a dependency via `dialog.tsx`) — no new dependency.

## Global Constraints

- **Scope = "don't break on mobile"** (decided in brainstorming): no tables→cards transforms, no enlarged touch targets, no mobile-only layouts. Phones/tablets-portrait must be usable and readable with **zero horizontal overflow**; laptop is the primary device.
- **Breakpoint divide = `lg` (1024px).** Below `lg`: single column + drawer nav. At/above `lg`: fixed sidebar, layout unchanged from today.
- **No new npm/pnpm dependency.** The drawer reuses `@radix-ui/react-dialog`.
- **User-facing strings in Italian**, hardcoded as in the rest of the web app (no i18n in this app yet). Code comments in English.
- **No emoji** in code or commit messages.
- **TypeScript strict**: no `any` without a justifying comment.
- **Tier 2 testing** for UI (per CLAUDE.md): 2-3 targeted tests for conditional logic (drawer open/close), **no pure-rendering tests**. Visual correctness is covered by the mandatory smoke runbook.
- **Local pre-push gate is `pnpm -r typecheck` only.** Do not run integration tests locally. Targeted `pnpm --filter @garageos/web test:unit` is allowed while debugging a specific failure.
- Branch: `feat/web-responsive-layout`. Conventional Commits, scope `web`.

---

### Task 1: Fluid root font-size for readability

**Files:**
- Modify: `packages/web/src/globals.css` (the `body` base layer block, around lines 52-62)

**Interfaces:**
- Consumes: nothing.
- Produces: a larger effective rem unit on laptops. No code symbols; later tasks rely only on the fact that `1rem` now scales between 16px and 18px.

CSS is not unit-tested (JSDOM has no layout engine). Verification is the build + the smoke runbook.

- [ ] **Step 1: Add the fluid root font-size rule**

In `packages/web/src/globals.css`, inside the second `@layer base { ... }` block, add an `html` rule immediately before the `body` rule. Final block:

```css
@layer base {
  * {
    @apply border-border;
  }
  html {
    /* Fluid base size: 16px floor (mobile stays readable), grows with the
       viewport on laptops, capped at 18px so large monitors don't blow up.
       Tailwind v3 breakpoints are px-based, so this does not shift them. */
    font-size: clamp(16px, 0.6vw + 13.5px, 18px);
  }
  body {
    @apply bg-background text-foreground;
    font-feature-settings:
      'rlig' 1,
      'calt' 1;
  }
}
```

- [ ] **Step 2: Verify the build compiles the CSS**

Run: `pnpm --filter @garageos/web build`
Expected: build succeeds (Vite + Tailwind process `globals.css` with no errors).

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/globals.css
git commit -m "feat(web): fluid root font-size for laptop readability"
```

---

### Task 2: Extract shared nav content into `SidebarNav`

The desktop `<aside>` and the mobile drawer must render the *same* nav markup. Extract the inner content of `Sidebar` into a `SidebarNav` component that accepts an optional `onNavigate` callback (the drawer uses it to close on link click). `Sidebar` stays a thin desktop wrapper so its existing tests keep passing unchanged.

**Files:**
- Create: `packages/web/src/components/layout/SidebarNav.tsx`
- Modify: `packages/web/src/components/layout/Sidebar.tsx`
- Existing test (must stay green, no edit expected): `packages/web/src/components/layout/Sidebar.test.tsx`

**Interfaces:**
- Produces: `SidebarNav({ onNavigate }: { onNavigate?: () => void })` — renders brand, "Nuovo veicolo" link, nav items, and "Esci" button. Calls `onNavigate?.()` on every navigation interaction (the "Nuovo veicolo" link, each enabled nav `Link`, and "Esci").
- Produces: `Sidebar()` — unchanged external behavior; renders `<aside>` wrapping `<SidebarNav />`.

- [ ] **Step 1: Create `SidebarNav.tsx`**

```tsx
// IT-strings — hardcoded, no i18n in this app
import { Link, useLocation } from 'react-router-dom';
import { Home, Wrench, Users, Settings, LogOut, Calendar, Plus } from 'lucide-react';
import { useAuth } from '@/auth/useAuth';
import { Separator } from '@/components/ui/separator';

const navItems = [
  { id: 'home', label: 'Home', icon: Home, to: '/', enabled: true },
  { id: 'interventions', label: 'Interventi', icon: Wrench, enabled: false },
  { id: 'deadlines', label: 'Scadenze', icon: Calendar, to: '/deadlines', enabled: true },
  { id: 'customers', label: 'Clienti', icon: Users, to: '/customers', enabled: true },
  { id: 'settings', label: 'Impostazioni', icon: Settings, to: '/settings', enabled: true },
] as const;

function isActiveFor(itemId: string, pathname: string): boolean {
  if (itemId === 'home') return pathname === '/';
  if (itemId === 'deadlines') return pathname.startsWith('/deadlines');
  if (itemId === 'settings') return pathname.startsWith('/settings');
  if (itemId === 'customers') return pathname.startsWith('/customers');
  return false;
}

export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const { pathname } = useLocation();
  const { signOut } = useAuth();

  return (
    <div className="flex flex-col h-full p-4">
      <div className="font-bold text-lg tracking-tight mb-6 flex items-center gap-2">
        <div className="w-8 h-8 bg-blue-600 rounded flex items-center justify-center">G</div>
        GarageOS
      </div>
      <Link
        to="/vehicles/new"
        onClick={() => onNavigate?.()}
        className="flex items-center justify-center gap-2 mb-4 px-3 py-2 rounded-md text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white transition"
      >
        <Plus size={16} />
        Nuovo veicolo
      </Link>
      <nav className="flex-1 space-y-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          if (item.enabled && 'to' in item) {
            const active = isActiveFor(item.id, pathname);
            return (
              <Link
                key={item.id}
                to={item.to}
                onClick={() => onNavigate?.()}
                aria-current={active ? 'page' : undefined}
                className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm transition ${
                  active ? 'bg-blue-900 text-white' : 'text-slate-300 hover:bg-slate-800'
                }`}
              >
                <Icon size={16} />
                {item.label}
              </Link>
            );
          }
          return (
            <div
              key={item.id}
              aria-disabled="true"
              title="Disponibile in v1.1"
              className="flex items-center gap-2 px-3 py-2 rounded-md text-sm text-slate-500 cursor-not-allowed"
            >
              <Icon size={16} />
              {item.label}
              <span className="ml-auto text-[10px] uppercase tracking-wide">soon</span>
            </div>
          );
        })}
      </nav>
      <Separator className="bg-slate-700 my-3" />
      <button
        type="button"
        onClick={() => {
          onNavigate?.();
          signOut();
        }}
        className="flex items-center gap-2 px-3 py-2 rounded-md text-sm text-slate-300 hover:bg-slate-800 transition"
      >
        <LogOut size={16} />
        Esci
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Replace `Sidebar.tsx` body with a thin wrapper**

```tsx
import { SidebarNav } from './SidebarNav';

export function Sidebar() {
  return (
    <aside className="w-[220px] bg-slate-900 dark:bg-slate-950 text-white border-r border-slate-800 dark:border-slate-900">
      <SidebarNav />
    </aside>
  );
}
```

- [ ] **Step 3: Run the existing Sidebar tests to confirm no regression**

Run: `pnpm --filter @garageos/web test:unit -- Sidebar`
Expected: all `Sidebar.test.tsx` tests PASS (links, active state, "Esci" calls signOut, "Nuovo veicolo" link present). The "Esci" test asserts `signOut` called once — the wrapper still calls it once.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @garageos/web typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/layout/SidebarNav.tsx packages/web/src/components/layout/Sidebar.tsx
git commit -m "refactor(web): extract SidebarNav for reuse in mobile drawer"
```

---

### Task 3: Responsive shell — Sheet primitive, drawer in AppLayout, hamburger + mobile search in TopBar

This is the core. Add a minimal left-side `Sheet` (Radix Dialog), make `AppLayout` single-column below `lg` with a drawer, and add the hamburger + collapsible search to `TopBar`.

**Files:**
- Create: `packages/web/src/components/ui/sheet.tsx`
- Modify: `packages/web/src/components/layout/AppLayout.tsx`
- Modify: `packages/web/src/components/layout/TopBar.tsx`
- Create test: `packages/web/src/components/layout/MobileNav.test.tsx`
- (TopBar already has `packages/web/src/components/layout/TopBar.test.tsx` — keep it green; add 1 case for the hamburger.)

**Interfaces:**
- Consumes: `SidebarNav({ onNavigate })` from Task 2.
- Produces: `Sheet`, `SheetContent`, `SheetTrigger`, `SheetTitle` (Radix Dialog re-exports with a left-slide `SheetContent`).
- Produces: `AppLayout` holds `navOpen` state; renders the desktop `<Sidebar/>` inside `hidden lg:block`, a mobile `<Sheet open={navOpen}>` containing `<SidebarNav onNavigate={() => setNavOpen(false)} />`, and `<TopBar onMenuClick={() => setNavOpen(true)} />`.
- Produces: `TopBar({ onMenuClick }: { onMenuClick: () => void })` — new required prop.

- [ ] **Step 1: Create the `Sheet` primitive (`sheet.tsx`)**

Minimal left-side sheet on Radix Dialog (same library as `dialog.tsx`). Only the left variant is needed.

```tsx
import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

const Sheet = DialogPrimitive.Root;
const SheetTrigger = DialogPrimitive.Trigger;
const SheetClose = DialogPrimitive.Close;
const SheetTitle = DialogPrimitive.Title;

const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        'fixed inset-y-0 left-0 z-50 h-full w-[260px] max-w-[80vw] border-r border-slate-800 bg-slate-900 dark:bg-slate-950 text-white shadow-lg outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left',
        className,
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close className="absolute right-3 top-3 rounded-sm opacity-70 transition hover:opacity-100">
        <X size={18} />
        <span className="sr-only">Chiudi</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
SheetContent.displayName = 'SheetContent';

export { Sheet, SheetTrigger, SheetClose, SheetContent, SheetTitle };
```

Note: `cn` lives at `@/lib/utils` (used by other ui components). If that path differs, check an existing ui file's import (e.g. `button.tsx`) and match it.

- [ ] **Step 2: Make `AppLayout` responsive with the drawer**

```tsx
import { useState } from 'react';
import { Outlet } from 'react-router-dom';

import { LocationFilterProvider } from '@/location-filter/LocationFilterContext';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';

import { Sidebar } from './Sidebar';
import { SidebarNav } from './SidebarNav';
import { TopBar } from './TopBar';

export function AppLayout() {
  const [navOpen, setNavOpen] = useState(false);

  return (
    <LocationFilterProvider>
      <div className="min-h-screen lg:grid lg:grid-cols-[220px_1fr] bg-background text-foreground">
        {/* Desktop sidebar — hidden below lg, replaced by the drawer */}
        <div className="hidden lg:block">
          <Sidebar />
        </div>

        {/* Mobile drawer — same nav content, closes on navigation */}
        <Sheet open={navOpen} onOpenChange={setNavOpen}>
          <SheetContent data-testid="mobile-drawer">
            <SheetTitle className="sr-only">Menu di navigazione</SheetTitle>
            <SidebarNav onNavigate={() => setNavOpen(false)} />
          </SheetContent>
        </Sheet>

        <div className="flex flex-col min-h-screen min-w-0">
          <TopBar onMenuClick={() => setNavOpen(true)} />
          <main className="flex-1 bg-background min-w-0">
            <div className="max-w-[1600px] mx-auto">
              <Outlet />
            </div>
          </main>
        </div>
      </div>
    </LocationFilterProvider>
  );
}
```

`min-w-0` on the content column and `<main>` prevents a wide child (e.g. a long timeline row) from stretching the grid track and causing page overflow.

- [ ] **Step 3: Add hamburger + collapsible mobile search to `TopBar`**

Add the `onMenuClick` prop, a hamburger button visible only below `lg`, keep the inline search as desktop-only (`hidden lg:block`), and add a mobile search icon that toggles a full-width overlay search row.

```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, LogOut, Menu, Search, X } from 'lucide-react';

import { useAuth } from '@/auth/useAuth';
import { LocationSelector } from '@/location-filter/LocationSelector';
import { getInitials } from '@/lib/initials';
import { useProfileMe } from '@/queries/profileMe';
import { ThemeToggle } from '@/theme/ThemeToggle';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function TopBar({ onMenuClick }: { onMenuClick: () => void }) {
  const { state, signOut } = useAuth();
  const profileQuery = useProfileMe();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);

  const authedEmail = state.status === 'authenticated' ? state.user.email : '';
  const profile = profileQuery.data;
  const avatarUrl = profile?.avatarUrl ?? null;
  const initials = profile ? getInitials(profile.firstName, profile.lastName) : '?';
  const officinaName = profile ? `Officina ${profile.tenant.businessName}` : 'GarageOS';
  const sedeName = profile?.location?.name ?? null;

  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = query.trim();
    if (trimmed.length === 0) return;
    if (trimmed.length < 2) {
      setError('Inserisci almeno 2 caratteri.');
      return;
    }
    setError(null);
    setMobileSearchOpen(false);
    navigate(`/search?q=${encodeURIComponent(trimmed)}`);
  }

  return (
    <header className="relative bg-card border-b border-border px-4 lg:px-6 py-3 flex items-center gap-3 lg:gap-4">
      {/* Hamburger — mobile/tablet only */}
      <button
        type="button"
        onClick={onMenuClick}
        className="lg:hidden shrink-0 text-foreground hover:opacity-80 transition"
        aria-label="Apri menu"
      >
        <Menu size={20} />
      </button>

      {/* Brand — hidden on the narrowest screens to save room */}
      <div className="hidden sm:block text-xs font-medium uppercase tracking-wider shrink-0 truncate max-w-[40vw]">
        <span className="text-foreground">{officinaName}</span>
        {sedeName && <span className="text-muted-foreground"> · {sedeName}</span>}
      </div>

      {/* Desktop inline search */}
      <form onSubmit={submitSearch} className="hidden lg:block flex-1 max-w-xl mx-auto" role="search">
        <div className="relative">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
          />
          <Input
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (error) setError(null);
            }}
            placeholder="Cerca veicolo o cliente…"
            className="pl-9 h-9"
            aria-label="Cerca"
            aria-invalid={error !== null}
          />
          {error && (
            <div
              role="alert"
              className="absolute left-0 right-0 top-full mt-1 text-xs text-destructive bg-card border border-destructive/40 rounded px-2 py-1 shadow-sm"
            >
              {error}
            </div>
          )}
        </div>
      </form>

      {/* Spacer pushes the right cluster to the edge below lg */}
      <div className="flex-1 lg:hidden" />

      <div className="flex items-center gap-2 shrink-0">
        {/* Mobile search trigger */}
        <button
          type="button"
          onClick={() => setMobileSearchOpen(true)}
          className="lg:hidden text-foreground hover:opacity-80 transition"
          aria-label="Cerca"
        >
          <Search size={18} />
        </button>
        <LocationSelector />
        <ThemeToggle />
        <DropdownMenu>
          <DropdownMenuTrigger className="flex items-center gap-2 text-sm text-foreground hover:opacity-80 transition">
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt=""
                className="w-8 h-8 rounded-full object-cover bg-muted"
                data-testid="topbar-avatar-img"
              />
            ) : (
              <div
                className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-xs font-semibold"
                data-testid="topbar-avatar-initials"
              >
                {initials}
              </div>
            )}
            {/* Email is noise on mobile — desktop only */}
            <span className="hidden lg:inline">{authedEmail}</span>
            <ChevronDown size={14} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={signOut}>
              <LogOut size={14} className="mr-2" /> Esci
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Mobile search overlay row — covers the header when open */}
      {mobileSearchOpen && (
        <form
          onSubmit={submitSearch}
          role="search"
          className="absolute inset-0 z-10 flex items-center gap-2 bg-card px-4"
        >
          <div className="relative flex-1">
            <Search
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
            />
            <Input
              type="search"
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                if (error) setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setMobileSearchOpen(false);
              }}
              placeholder="Cerca veicolo o cliente…"
              className="pl-9 h-9"
              aria-label="Cerca"
              aria-invalid={error !== null}
            />
            {error && (
              <div
                role="alert"
                className="absolute left-0 right-0 top-full mt-1 text-xs text-destructive bg-card border border-destructive/40 rounded px-2 py-1 shadow-sm"
              >
                {error}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => setMobileSearchOpen(false)}
            className="shrink-0 text-foreground hover:opacity-80 transition"
            aria-label="Chiudi ricerca"
          >
            <X size={18} />
          </button>
        </form>
      )}
    </header>
  );
}
```

- [ ] **Step 4: Write the failing MobileNav test**

Create `packages/web/src/components/layout/MobileNav.test.tsx`. It renders `AppLayout` (with the providers it needs) and asserts the drawer opens from the hamburger and closes on nav-link click. Because `AppLayout` renders `<Outlet/>`, wrap it in a `MemoryRouter` with a matching route.

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AppLayout } from './AppLayout';
import { AuthContext, type AuthContextValue } from '@/auth/AuthContext';

// useProfileMe hits react-query; stub it so TopBar renders without a client.
vi.mock('@/queries/profileMe', () => ({
  useProfileMe: () => ({ data: undefined }),
}));

const mockAuth = (overrides: Partial<AuthContextValue> = {}): AuthContextValue => ({
  state: { status: 'authenticated', user: { email: 'm@x.com' } },
  signIn: vi.fn(),
  signOut: vi.fn(),
  getIdToken: vi.fn().mockResolvedValue('jwt'),
  ...overrides,
});

function renderLayout() {
  return render(
    <AuthContext.Provider value={mockAuth()}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/" element={<div>home content</div>} />
            <Route path="/customers" element={<div>customers content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe('AppLayout mobile drawer', () => {
  it('opens the nav drawer from the hamburger', async () => {
    renderLayout();
    // Drawer nav link not in the document until opened
    expect(screen.queryByRole('link', { name: /clienti/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /apri menu/i }));
    expect(await screen.findByRole('link', { name: /clienti/i })).toBeInTheDocument();
  });

  it('closes the drawer when a nav link is clicked', async () => {
    renderLayout();
    await userEvent.click(screen.getByRole('button', { name: /apri menu/i }));
    const link = await screen.findByRole('link', { name: /clienti/i });
    await userEvent.click(link);
    // After navigation the drawer closes → link removed from the DOM
    expect(screen.queryByRole('link', { name: /clienti/i })).not.toBeInTheDocument();
  });
});
```

Note: the desktop `<Sidebar/>` is wrapped in `hidden lg:block` but JSDOM still mounts it, so its nav links *would* be queryable. To keep the test unambiguous, the desktop wrapper must not render its links in JSDOM's "mobile" default — but JSDOM has no real CSS, so `hidden` does not remove nodes. **Resolution:** the desktop `<Sidebar/>` is always in the DOM, so the assertions above would find its links even when the drawer is closed. To avoid coupling the test to CSS, the desktop sidebar links and the drawer links are both present. Therefore assert on the **drawer specifically**: give `SheetContent` a `data-testid="mobile-drawer"` and scope queries with `within(screen.getByTestId('mobile-drawer'))`. Update `AppLayout` Step 2 to add `data-testid="mobile-drawer"` on `<SheetContent>`, and rewrite the test queries:

```tsx
import { within } from '@testing-library/react';
// open:
await userEvent.click(screen.getByRole('button', { name: /apri menu/i }));
const drawer = await screen.findByTestId('mobile-drawer');
expect(within(drawer).getByRole('link', { name: /clienti/i })).toBeInTheDocument();
// closed (before opening, or after link click): the drawer is not rendered
expect(screen.queryByTestId('mobile-drawer')).not.toBeInTheDocument();
```

Radix Dialog only mounts `SheetContent` (and its portal) while `open`, so `queryByTestId('mobile-drawer')` is absent when closed — this is the reliable signal. Add `data-testid="mobile-drawer"` to `<SheetContent>` in `AppLayout`.

- [ ] **Step 5: Run the test to verify it fails (component not yet wired / prop missing)**

Run: `pnpm --filter @garageos/web test:unit -- MobileNav`
Expected: FAIL until Steps 1-3 are complete and `data-testid` is added. Once wired, re-run → PASS.

- [ ] **Step 6: Add the hamburger assertion to the existing TopBar test**

`TopBar.test.tsx` now must pass `onMenuClick`. Update its render helper to pass `onMenuClick={vi.fn()}` and add one case:

```tsx
it('calls onMenuClick when the hamburger is pressed', async () => {
  const onMenuClick = vi.fn();
  renderTopBar({ onMenuClick }); // ensure the helper forwards the prop
  await userEvent.click(screen.getByRole('button', { name: /apri menu/i }));
  expect(onMenuClick).toHaveBeenCalledOnce();
});
```

Inspect `TopBar.test.tsx`'s existing render helper and thread the `onMenuClick` prop through it (all existing renders must supply it, since it is now required).

- [ ] **Step 7: Run the full web unit suite for the layout**

Run: `pnpm --filter @garageos/web test:unit -- layout`
Expected: `Sidebar`, `TopBar`, and `MobileNav` suites all PASS.

- [ ] **Step 8: Typecheck**

Run: `pnpm --filter @garageos/web typecheck`
Expected: no errors (note `TopBar` now requires `onMenuClick`; AppLayout supplies it).

- [ ] **Step 9: Commit**

```bash
git add packages/web/src/components/ui/sheet.tsx packages/web/src/components/layout/AppLayout.tsx packages/web/src/components/layout/TopBar.tsx packages/web/src/components/layout/TopBar.test.tsx packages/web/src/components/layout/MobileNav.test.tsx
git commit -m "feat(web): responsive app shell with mobile nav drawer"
```

---

### Task 4: Reflow sweep for full-page views that overflow below `lg`

Fix the few full-page views whose fixed grids / padding / non-wrapping button clusters cause horizontal overflow on narrow viewports. `HomeDashboard` and the dashboard cards are already responsive (`grid-cols-1 md:grid-cols-...`) — leave them. Apply the standard substitution set and verify each page at a 375px-wide viewport.

**Standard substitution set (apply only where the current class is non-responsive):**
- Container padding: `p-8` → `p-4 md:p-8`; `p-6` → `p-4 md:p-6`.
- Fixed multi-column grids: `grid-cols-4` → `grid-cols-2 lg:grid-cols-4`; `grid-cols-3` → `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`. Only for grids that currently have **no** responsive prefix.
- Action button clusters in page headers (`flex items-* justify-between` rows containing 2+ buttons): add `flex-wrap` to the row, and make the wrapping header `flex-col gap-3 sm:flex-row sm:items-start sm:justify-between` where the title + actions otherwise collide.
- Wide horizontally-scrolling content (long timeline/table rows): wrap the scrolling region in `<div className="overflow-x-auto">` as an overflow safety net so the page itself never gains a horizontal scrollbar.

**Files (audit each at 375px; apply the set where needed):**
- Modify: `packages/web/src/pages/VehicleDetail.tsx` — concrete edits below.
- Modify: `packages/web/src/pages/InterventionDetail.tsx`
- Modify: `packages/web/src/pages/CustomerDetail.tsx`
- Modify: `packages/web/src/pages/SearchResults.tsx`
- Modify: `packages/web/src/pages/VehicleCreate.tsx`
- Modify: `packages/web/src/pages/DeadlineDashboard.tsx`
- Modify: `packages/web/src/pages/CustomerList.tsx`
- Modify: `packages/web/src/pages/Settings.tsx`

**Interfaces:** none (pure className edits; no logic, no new exports).

- [ ] **Step 1: Apply the concrete `VehicleDetail.tsx` edits (the canonical example)**

Three edits:

1. Outer padding (line ~110): `className="p-8 space-y-8"` → `className="p-4 md:p-8 space-y-6 md:space-y-8"`.

2. Header row with the action button cluster (line ~115): change
   `<div className="flex items-start justify-between gap-4">`
   to
   `<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between gap-4">`
   and on the inner actions wrapper (line ~126) `<div className="flex items-center gap-2">` add wrapping:
   `<div className="flex flex-wrap items-center gap-2">`.

3. Spec cards grid (line ~165): `className="grid grid-cols-4 gap-3"` → `className="grid grid-cols-2 lg:grid-cols-4 gap-3"`.

- [ ] **Step 2: Sweep the remaining files**

For each remaining file in the list, open it, find non-responsive `p-8`/`p-6`, fixed `grid-cols-3`/`grid-cols-4`, and 2+-button header rows without `flex-wrap`, and apply the standard substitution set. Do not touch grids that already carry a responsive prefix. Do not restyle anything that already reflows.

- [ ] **Step 3: Typecheck (className-only edits must still compile)**

Run: `pnpm --filter @garageos/web typecheck`
Expected: no errors.

- [ ] **Step 4: Run the affected page test suites**

Run: `pnpm --filter @garageos/web test:unit`
Expected: all PASS. className changes must not break any DOM query in existing page tests; if a test queried by a class (unlikely — they query by role/text), fix the assertion, not the responsive class.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/pages
git commit -m "fix(web): reflow full-page views to avoid mobile overflow"
```

---

## Final verification (before PR)

- [ ] **Typecheck the whole web package:** `pnpm --filter @garageos/web typecheck` → clean.
- [ ] **Run the web unit suite:** `pnpm --filter @garageos/web test:unit` → green.
- [ ] **Smoke runbook (MANDATORY for shell/layout PRs — blocking):**
  - On a real phone (or a 375px-wide browser window): every protected route (`/`, `/search?q=...`, `/vehicles/:id`, `/customers`, `/customers/:id`, `/deadlines`, `/interventions/:id`, `/settings`) shows **no horizontal scrollbar**.
  - Hamburger opens the drawer; tapping a nav item navigates and closes it; overlay/X close it; the active item is highlighted.
  - Mobile search icon opens the overlay row, submitting `>= 2` chars navigates to `/search`, `< 2` shows the inline error, X/Escape closes it.
  - At `lg+` (>= 1024px) the layout is visually **unchanged** from today (fixed sidebar, inline search, email visible).
  - On a 14" laptop (or ~1280-1440px window) body text and controls read comfortably larger than before; on a wide monitor (>= 1800px) text is capped (not oversized).
  - Toggle dark mode on mobile and re-check the drawer contrast.
- [ ] **Final whole-branch review:** run `/code-review high` on the branch. Apply Critical/Important findings; list Minor/cosmetic in the PR description.
- [ ] **Run `graphify update .`** to refresh the knowledge graph after the code changes.

## PR

- Branch `feat/web-responsive-layout`; PR title `feat(web): responsive layout for mobile + laptop readability`.
- PR description: What/Why/Implementation notes/Tests per CLAUDE.md template. Note the scope decision (don't-break-on-mobile, `lg` divide, search-behind-icon) and that no tables→cards transform was done by design. Attach before/after screenshots at 375px and 1366px.
- Watch CI green (`gh pr checks --watch`), then squash-merge with `--delete-branch`.
