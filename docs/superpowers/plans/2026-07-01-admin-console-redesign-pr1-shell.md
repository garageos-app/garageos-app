# Admin Console Redesign — PR1 Shell Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `packages/admin-web` a real application shell — a shadcn **inset** sidebar (collapsible to an icon rail, persisted) + a topbar with theme toggle — replacing the per-page inline navigation, without changing any behavior.

**Architecture:** Adopt the official shadcn `sidebar` block. Protected routes render under a single `AppLayout` (`SidebarProvider` → `AppSidebar` `variant="inset"` + `SidebarInset` → `Topbar` + `<Outlet/>`). Navigation lives in `NavMain` (sidebar), user identity + sign-out in `NavUser` (sidebar footer), light/dark theme is ported from `packages/web`. Login/SetPassword stay outside the shell. This is a presentation-layer change only.

**Tech Stack:** React 19, react-router-dom v6, TailwindCSS v3 (`darkMode: ['class']`), shadcn/ui (new-york, slate, `components.json` present), lucide-react, Vitest + Testing Library (jsdom).

## Global Constraints

- **Scope:** `packages/admin-web` only. No changes to API, DB, migrations, business rules (`BR-XXX`), or error codes.
- **No new behavior:** auth flow, data fetching, mutations, and dialogs are unchanged. Routes' *targets* are unchanged; only their *composition* under a layout changes.
- **User-facing strings are Italian, hardcoded** (this app has no i18n — mirror `packages/web` `SidebarNav` which marks `// IT-strings`). Comments in English.
- **No emoji** in code or commit messages.
- **TypeScript strict**; no `any` without an inline justification comment.
- **New dependencies** (added by the shadcn CLI, all standard radix primitives already used in `packages/web`): `@radix-ui/react-tooltip`, `@radix-ui/react-dropdown-menu`, `@radix-ui/react-separator`. Justify them in the PR description.
- **Testing = Tier 2** (UI): implement first, then 2-3 targeted tests per unit (happy path, error/conditional state). **No pure-rendering tests.**
- **Local gate:** `pnpm -r typecheck` (husky pre-push). Add a targeted `pnpm --filter @garageos/admin-web test` run while working on components with tests. Full lint/test matrix runs on CI.
- **Commit style:** Conventional Commits, scope `admin-web` (e.g. `feat(admin-web): ...`). Branch `feat/admin-console-redesign-shell` (already created; spec committed at `6eed8a9`).
- **Node:** use Node 22 via fnm before running the shadcn CLI / pnpm (repo engine pin is `>=22.22.0 <23`).

---

### Task 1: Add shadcn ui primitives, sidebar CSS tokens, and matchMedia polyfill

Adds the vendored shadcn components the shell needs (`sidebar` pulls in `tooltip`, `sheet`, `skeleton`, `separator`, and the `use-mobile` hook; plus `breadcrumb` and `dropdown-menu`), the `--sidebar-*` design tokens, and the `matchMedia` test polyfill the `use-mobile` hook requires under jsdom.

**Files:**
- Create (via CLI): `packages/admin-web/src/components/ui/sidebar.tsx`, `tooltip.tsx`, `sheet.tsx`, `skeleton.tsx`, `separator.tsx`, `breadcrumb.tsx`, `dropdown-menu.tsx`
- Create (via CLI): `packages/admin-web/src/hooks/use-mobile.ts` (aka `use-mobile.tsx`)
- Modify: `packages/admin-web/src/globals.css` (add `--sidebar-*` tokens to `:root` and `.dark`)
- Modify: `packages/admin-web/tailwind.config.ts` (add `sidebar` color group)
- Modify: `packages/admin-web/tests/setup.ts` (add `window.matchMedia` polyfill)
- Modify: `packages/admin-web/package.json` (radix deps added by CLI)

**Interfaces:**
- Produces (consumed by later tasks): the shadcn sidebar API — `SidebarProvider`, `Sidebar`, `SidebarInset`, `SidebarTrigger`, `SidebarRail`, `SidebarHeader`, `SidebarContent`, `SidebarFooter`, `SidebarGroup`, `SidebarGroupContent`, `SidebarGroupLabel`, `SidebarMenu`, `SidebarMenuItem`, `SidebarMenuButton`, `useSidebar` from `@/components/ui/sidebar`; `DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuItem`, `DropdownMenuLabel`, `DropdownMenuSeparator` from `@/components/ui/dropdown-menu`; `Breadcrumb*` from `@/components/ui/breadcrumb`.

- [ ] **Step 1: Run the shadcn CLI from the admin-web package**

Run (ensure Node 22 via fnm first):

```bash
cd packages/admin-web
pnpm dlx shadcn@latest add sidebar breadcrumb dropdown-menu --yes
```

`sidebar` transitively adds `tooltip`, `sheet`, `skeleton`, `separator`, `button`, `input`, and `src/hooks/use-mobile.*`.

- [ ] **Step 2: Verify the CLI output and restore any clobbered pre-existing files**

Run:

```bash
git status --short packages/admin-web/src/components/ui
git diff --stat packages/admin-web/src/components/ui/button.tsx packages/admin-web/src/components/ui/input.tsx
```

Expected: NEW files `sidebar.tsx tooltip.tsx sheet.tsx skeleton.tsx separator.tsx breadcrumb.tsx dropdown-menu.tsx` and `src/hooks/use-mobile.*`.
- If `button.tsx` or `input.tsx` (pre-existing) were modified by the CLI, restore them: `git checkout -- packages/admin-web/src/components/ui/button.tsx packages/admin-web/src/components/ui/input.tsx`. (The shadcn `buttonVariants`/`Input` API is stable; the sidebar imports are compatible.)
- Guard against the known `@/` literal-dir gotcha: `ls packages/admin-web` must NOT show a directory literally named `@`. If present, move its contents into `src/` and delete it.
- Confirm no unexpected dependency bumps: `git diff packages/admin-web/package.json` should add only `@radix-ui/react-tooltip`, `@radix-ui/react-dropdown-menu`, `@radix-ui/react-separator` (and possibly `@radix-ui/react-slot` if not already present — it is). Revert any unrelated version changes.

- [ ] **Step 3: Add the `--sidebar-*` tokens to `globals.css`**

In `packages/admin-web/src/globals.css`, inside the existing `:root` block (after `--radius`), add:

```css
    --sidebar-background: 0 0% 98%;
    --sidebar-foreground: 240 5.3% 26.1%;
    --sidebar-primary: 240 5.9% 10%;
    --sidebar-primary-foreground: 0 0% 98%;
    --sidebar-accent: 240 4.8% 95.9%;
    --sidebar-accent-foreground: 240 5.9% 10%;
    --sidebar-border: 220 13% 91%;
    --sidebar-ring: 217.2 91.2% 59.8%;
```

Inside the existing `.dark` block (after `--ring`), add:

```css
    --sidebar-background: 240 5.9% 10%;
    --sidebar-foreground: 240 4.8% 95.9%;
    --sidebar-primary: 224.3 76.3% 48%;
    --sidebar-primary-foreground: 0 0% 100%;
    --sidebar-accent: 240 3.7% 15.9%;
    --sidebar-accent-foreground: 240 4.8% 95.9%;
    --sidebar-border: 240 3.7% 15.9%;
    --sidebar-ring: 217.2 91.2% 59.8%;
```

(The shadcn CLI may already have inserted these; if so, verify the values match and skip.)

- [ ] **Step 4: Add the `sidebar` color group to `tailwind.config.ts`**

In `packages/admin-web/tailwind.config.ts`, inside `theme.extend.colors` (after the `card` group), add:

```ts
        sidebar: {
          DEFAULT: 'hsl(var(--sidebar-background))',
          foreground: 'hsl(var(--sidebar-foreground))',
          primary: 'hsl(var(--sidebar-primary))',
          'primary-foreground': 'hsl(var(--sidebar-primary-foreground))',
          accent: 'hsl(var(--sidebar-accent))',
          'accent-foreground': 'hsl(var(--sidebar-accent-foreground))',
          border: 'hsl(var(--sidebar-border))',
          ring: 'hsl(var(--sidebar-ring))',
        },
```

(Again, the CLI may have added this; verify and dedupe.)

- [ ] **Step 5: Add the `matchMedia` polyfill to the test setup**

In `packages/admin-web/tests/setup.ts`, after the `scrollIntoView` polyfill block (before the Cognito env stubs), add:

```ts
// Polyfill matchMedia for the shadcn sidebar's useIsMobile hook in jsdom.
if (!window.matchMedia) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
}
```

- [ ] **Step 6: Typecheck and build**

Run:

```bash
pnpm --filter @garageos/admin-web typecheck
pnpm --filter @garageos/admin-web build
```

Expected: both PASS. (This task adds vendored primitives with no app wiring yet, so there is no unit test — the gate is a clean typecheck + build, per Tier-2 "no pure-rendering tests".)

- [ ] **Step 7: Commit**

```bash
git add packages/admin-web
git commit -m "feat(admin-web): add shadcn sidebar primitives, tokens, matchMedia polyfill"
```

---

### Task 2: Port the theme system (light/dark + toggle)

Ports the theme context/hook/toggle from `packages/web` verbatim (they have no web-app-specific dependencies).

**Files:**
- Create: `packages/admin-web/src/theme/ThemeContext.tsx`
- Create: `packages/admin-web/src/theme/useTheme.ts`
- Create: `packages/admin-web/src/theme/ThemeToggle.tsx`
- Test: `packages/admin-web/tests/theme.test.tsx`

**Interfaces:**
- Produces: `ThemeProvider` (wraps app), `useTheme()` → `{ theme: 'light' | 'dark'; setTheme(next); toggleTheme() }`, `ThemeToggle` (button, toggles `document.documentElement` `.dark` class + persists to `localStorage['garageos-theme']`).

- [ ] **Step 1: Write the failing test**

`packages/admin-web/tests/theme.test.tsx`:

```tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@/theme/ThemeContext';
import { ThemeToggle } from '@/theme/ThemeToggle';

beforeEach(() => {
  document.documentElement.classList.remove('dark');
  localStorage.clear();
});

describe('theme system', () => {
  it('toggles the dark class on the document root and persists', async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    await user.click(screen.getByRole('button', { name: /tema/i }));

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('garageos-theme')).toBe('dark');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/admin-web test -- theme`
Expected: FAIL — cannot resolve `@/theme/ThemeContext`.

- [ ] **Step 3: Create the three theme files (verbatim port)**

`packages/admin-web/src/theme/ThemeContext.tsx`:

```tsx
import { createContext, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Theme = 'light' | 'dark';

export interface ThemeContextValue {
  theme: Theme;
  setTheme: (next: Theme) => void;
  toggleTheme: () => void;
}

const STORAGE_KEY = 'garageos-theme';

function readStoredTheme(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'dark' || v === 'light' ? v : 'light';
  } catch {
    return 'light';
  }
}

function applyThemeClass(theme: Theme) {
  const root = document.documentElement;
  if (theme === 'dark') root.classList.add('dark');
  else root.classList.remove('dark');
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => readStoredTheme());

  useEffect(() => {
    applyThemeClass(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // localStorage may be disabled (private mode, quota); silently no-op.
    }
  }, [theme]);

  const setTheme = useCallback((next: Theme) => setThemeState(next), []);
  const toggleTheme = useCallback(
    () => setThemeState((prev) => (prev === 'dark' ? 'light' : 'dark')),
    [],
  );

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, setTheme, toggleTheme }),
    [theme, setTheme, toggleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
```

`packages/admin-web/src/theme/useTheme.ts`:

```ts
import { useContext } from 'react';
import { ThemeContext } from './ThemeContext';

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
```

`packages/admin-web/src/theme/ThemeToggle.tsx`:

```tsx
import { Moon, Sun } from 'lucide-react';
import { useTheme } from './useTheme';

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';
  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label="Cambia tema chiaro/scuro"
      aria-pressed={isDark}
      className="inline-flex items-center justify-center h-9 w-9 rounded-md text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100 transition"
    >
      {isDark ? (
        <Sun size={18} data-theme-icon="sun" aria-hidden="true" />
      ) : (
        <Moon size={18} data-theme-icon="moon" aria-hidden="true" />
      )}
    </button>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @garageos/admin-web test -- theme`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/admin-web/src/theme packages/admin-web/tests/theme.test.tsx
git commit -m "feat(admin-web): port light/dark theme system"
```

---

### Task 3: Build `NavMain`, `NavUser`, and `AppSidebar`

The sidebar body: brand header, a primary "Crea officina" call-to-action, the nav items (Dashboard / Officine / Audit) with active state, and the footer user block with a sign-out dropdown.

**Files:**
- Create: `packages/admin-web/src/components/layout/NavMain.tsx`
- Create: `packages/admin-web/src/components/layout/NavUser.tsx`
- Create: `packages/admin-web/src/components/layout/AppSidebar.tsx`
- Test: `packages/admin-web/tests/app-sidebar.test.tsx`

**Interfaces:**
- Consumes: sidebar primitives + `DropdownMenu*` from Task 1; `useAuth()` from `@/auth/useAuth` (→ `state`, `signOut`); `useLocation`/`Link` from `react-router-dom`.
- Produces: `AppSidebar` (no props) — consumed by Task 5's `AppLayout`. `NavMain` and `NavUser` are internal to `AppSidebar`.

- [ ] **Step 1: Write the failing test**

`packages/admin-web/tests/app-sidebar.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { SidebarProvider } from '@/components/ui/sidebar';
import { AppSidebar } from '@/components/layout/AppSidebar';

const { mockSignOut } = vi.hoisted(() => ({ mockSignOut: vi.fn() }));

vi.mock('@/auth/useAuth', () => ({
  useAuth: () => ({
    signOut: mockSignOut,
    state: {
      status: 'authenticated',
      user: { email: 'admin@garageos.it', givenName: 'Mario', familyName: 'Rossi' },
    },
    signIn: vi.fn(),
    getIdToken: vi.fn(),
    completeNewPassword: vi.fn(),
  }),
}));

function renderSidebar(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SidebarProvider>
        <AppSidebar />
      </SidebarProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => mockSignOut.mockReset());

describe('AppSidebar', () => {
  it('renders the nav items with the active item marked', () => {
    renderSidebar('/officine');
    const officine = screen.getByRole('link', { name: /officine/i });
    expect(officine).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: /dashboard/i })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: /audit/i })).toBeInTheDocument();
  });

  it('shows the admin identity and signs out from the footer menu', async () => {
    const user = userEvent.setup();
    renderSidebar('/');
    expect(screen.getByText('Mario Rossi')).toBeInTheDocument();
    expect(screen.getByText('admin@garageos.it')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /mario rossi/i }));
    await user.click(await screen.findByText(/esci/i));
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/admin-web test -- app-sidebar`
Expected: FAIL — cannot resolve `@/components/layout/AppSidebar`.

- [ ] **Step 3: Create `NavMain.tsx`**

```tsx
// IT-strings — hardcoded, no i18n in this app.
import { Link, useLocation } from 'react-router-dom';
import { LayoutDashboard, Building2, ScrollText } from 'lucide-react';
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';

const navItems = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, to: '/' },
  { id: 'officine', label: 'Officine', icon: Building2, to: '/officine' },
  { id: 'audit', label: 'Audit', icon: ScrollText, to: '/audit' },
] as const;

function isActiveFor(id: string, pathname: string): boolean {
  if (id === 'dashboard') return pathname === '/';
  if (id === 'officine') return pathname.startsWith('/officine');
  if (id === 'audit') return pathname.startsWith('/audit');
  return false;
}

export function NavMain() {
  const { pathname } = useLocation();
  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = isActiveFor(item.id, pathname);
            return (
              <SidebarMenuItem key={item.id}>
                <SidebarMenuButton asChild isActive={active} tooltip={item.label}>
                  <Link to={item.to} aria-current={active ? 'page' : undefined}>
                    <Icon />
                    <span>{item.label}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
```

- [ ] **Step 4: Create `NavUser.tsx`**

```tsx
// IT-strings — hardcoded, no i18n in this app.
import { ChevronsUpDown, LogOut } from 'lucide-react';
import { useAuth } from '@/auth/useAuth';
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

function initialsOf(name: string, email: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (email[0] ?? '?').toUpperCase();
}

export function NavUser() {
  const { state, signOut } = useAuth();
  const { isMobile } = useSidebar();

  const email = state.status === 'authenticated' ? state.user.email : '';
  const name =
    state.status === 'authenticated'
      ? [state.user.givenName, state.user.familyName].filter(Boolean).join(' ')
      : '';
  const displayName = name || email;
  const initials = initialsOf(name, email);

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground text-xs font-semibold">
                {initials}
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">{displayName}</span>
                <span className="truncate text-xs">{email}</span>
              </div>
              <ChevronsUpDown className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-lg"
            side={isMobile ? 'bottom' : 'right'}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">{displayName}</span>
                  <span className="truncate text-xs">{email}</span>
                </div>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={signOut}>
              <LogOut />
              Esci
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
```

- [ ] **Step 5: Create `AppSidebar.tsx`**

```tsx
// IT-strings — hardcoded, no i18n in this app.
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { NavMain } from './NavMain';
import { NavUser } from './NavUser';

export function AppSidebar() {
  return (
    <Sidebar variant="inset">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link to="/">
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold">
                  G
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">GarageOS</span>
                  <span className="truncate text-xs">Console piattaforma</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  className="bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground"
                  tooltip="Crea officina"
                >
                  <Link to="/officine/nuova">
                    <Plus />
                    <span>Crea officina</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <NavMain />
      </SidebarContent>
      <SidebarFooter>
        <NavUser />
      </SidebarFooter>
    </Sidebar>
  );
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @garageos/admin-web test -- app-sidebar`
Expected: PASS (both cases). If the dropdown item is not found, confirm the `matchMedia` polyfill (Task 1 Step 5) is present — `useSidebar().isMobile` depends on it.

- [ ] **Step 7: Commit**

```bash
git add packages/admin-web/src/components/layout packages/admin-web/tests/app-sidebar.test.tsx
git commit -m "feat(admin-web): add AppSidebar with nav and user menu"
```

---

### Task 4: Build the `Topbar`

A header row inside the inset content: the sidebar trigger, the current page title, and the theme toggle. No global search (out of scope per spec).

**Files:**
- Create: `packages/admin-web/src/components/layout/Topbar.tsx`
- Test: `packages/admin-web/tests/topbar.test.tsx`

**Interfaces:**
- Consumes: `SidebarTrigger` from `@/components/ui/sidebar` (needs a `SidebarProvider` ancestor); `ThemeToggle` from `@/theme/ThemeToggle`; `useLocation` from `react-router-dom`.
- Produces: `Topbar` (no props) — consumed by Task 5's `AppLayout`. Exports helper `titleForPath(pathname: string): string`.

- [ ] **Step 1: Write the failing test**

`packages/admin-web/tests/topbar.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SidebarProvider } from '@/components/ui/sidebar';
import { ThemeProvider } from '@/theme/ThemeContext';
import { Topbar, titleForPath } from '@/components/layout/Topbar';

function renderTopbar(path: string) {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[path]}>
        <SidebarProvider>
          <Topbar />
        </SidebarProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

describe('Topbar', () => {
  it('maps paths to Italian titles', () => {
    expect(titleForPath('/')).toBe('Dashboard');
    expect(titleForPath('/officine')).toBe('Officine');
    expect(titleForPath('/officine/nuova')).toBe('Crea officina');
    expect(titleForPath('/officine/abc-123')).toBe('Dettaglio officina');
    expect(titleForPath('/audit')).toBe('Audit');
  });

  it('renders the current title and the theme toggle', () => {
    renderTopbar('/audit');
    expect(screen.getByRole('heading', { name: 'Audit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /tema/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @garageos/admin-web test -- topbar`
Expected: FAIL — cannot resolve `@/components/layout/Topbar`.

- [ ] **Step 3: Create `Topbar.tsx`**

```tsx
// IT-strings — hardcoded, no i18n in this app.
import { useLocation } from 'react-router-dom';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { Separator } from '@/components/ui/separator';
import { ThemeToggle } from '@/theme/ThemeToggle';

export function titleForPath(pathname: string): string {
  if (pathname === '/') return 'Dashboard';
  if (pathname.startsWith('/officine/nuova')) return 'Crea officina';
  if (/^\/officine\/[^/]+$/.test(pathname)) return 'Dettaglio officina';
  if (pathname.startsWith('/officine')) return 'Officine';
  if (pathname.startsWith('/audit')) return 'Audit';
  return 'Console piattaforma';
}

export function Topbar() {
  const { pathname } = useLocation();
  const title = titleForPath(pathname);
  return (
    <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 h-4" />
      <h1 className="text-base font-semibold">{title}</h1>
      <div className="ml-auto">
        <ThemeToggle />
      </div>
    </header>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @garageos/admin-web test -- topbar`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/admin-web/src/components/layout/Topbar.tsx packages/admin-web/tests/topbar.test.tsx
git commit -m "feat(admin-web): add Topbar with page title and theme toggle"
```

---

### Task 5: Assemble `AppLayout`, wire routing + `ThemeProvider`, migrate pages

Compose the shell, restructure `App.tsx` so protected pages render inside it, wrap the app in `ThemeProvider`, strip each page's self-owned chrome, and update the affected tests.

**Files:**
- Create: `packages/admin-web/src/components/layout/AppLayout.tsx`
- Test: `packages/admin-web/tests/app-layout.test.tsx`
- Modify: `packages/admin-web/src/App.tsx`
- Modify: `packages/admin-web/src/pages/PlatformConsole.tsx`, `TenantList.tsx`, `TenantDetail.tsx`, `CreateTenant.tsx`, `AuditLogs.tsx`
- Modify: `packages/admin-web/tests/platform-console.test.tsx` (drop assertions on removed inline nav/identity)

**Interfaces:**
- Consumes: `SidebarProvider`, `SidebarInset` from Task 1; `AppSidebar` (Task 3); `Topbar` (Task 4); `ThemeProvider` (Task 2); `Outlet`, `ProtectedRoute` (existing).
- Produces: `AppLayout` element route.

- [ ] **Step 1: Create `AppLayout.tsx`**

```tsx
import { Outlet } from 'react-router-dom';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { AppSidebar } from './AppSidebar';
import { Topbar } from './Topbar';

export function AppLayout() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <Topbar />
        <div className="p-4 lg:p-6">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
```

- [ ] **Step 2: Write the failing layout test**

`packages/admin-web/tests/app-layout.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ThemeProvider } from '@/theme/ThemeContext';
import { AppLayout } from '@/components/layout/AppLayout';

vi.mock('@/auth/useAuth', () => ({
  useAuth: () => ({
    signOut: vi.fn(),
    state: {
      status: 'authenticated',
      user: { email: 'admin@garageos.it', givenName: 'Mario', familyName: 'Rossi' },
    },
    signIn: vi.fn(),
    getIdToken: vi.fn(),
    completeNewPassword: vi.fn(),
  }),
}));

describe('AppLayout', () => {
  it('renders the sidebar nav, topbar title, and the routed page content', () => {
    render(
      <ThemeProvider>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route element={<AppLayout />}>
              <Route path="/" element={<div>dashboard-content</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ThemeProvider>,
    );
    expect(screen.getByRole('link', { name: /officine/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByText('dashboard-content')).toBeInTheDocument();
  });
});
```

Run: `pnpm --filter @garageos/admin-web test -- app-layout`
Expected: FAIL — cannot resolve `@/components/layout/AppLayout` (until Step 1 saved) then PASS after Step 1. If it still fails, proceed to wire it in the following steps and re-run at Step 7.

- [ ] **Step 3: Rewrite `App.tsx` routing + `ThemeProvider`**

Replace `packages/admin-web/src/App.tsx` with:

```tsx
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@/theme/ThemeContext';
import { AuthProvider } from '@/auth/AuthContext';
import { ProtectedRoute } from '@/auth/ProtectedRoute';
import { AppLayout } from '@/components/layout/AppLayout';
import { Login } from '@/pages/Login';
import { SetPassword } from '@/pages/SetPassword';
import { PlatformConsole } from '@/pages/PlatformConsole';
import { CreateTenant } from '@/pages/CreateTenant';
import { TenantDetail } from '@/pages/TenantDetail';
import { TenantList } from '@/pages/TenantList';
import { AuditLogs } from '@/pages/AuditLogs';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 5 * 60 * 1000,
    },
  },
});

export function App() {
  return (
    <BrowserRouter>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <Routes>
              {/* Public routes — outside the shell */}
              <Route path="/login" element={<Login />} />
              <Route path="/set-password" element={<SetPassword />} />

              {/* Protected routes — ProtectedRoute guards, AppLayout provides the shell */}
              <Route element={<ProtectedRoute />}>
                <Route element={<AppLayout />}>
                  <Route path="/" element={<PlatformConsole />} />
                  <Route path="/officine" element={<TenantList />} />
                  <Route path="/officine/nuova" element={<CreateTenant />} />
                  {/* /officine/nuova before /officine/:id — static ranks over dynamic. */}
                  <Route path="/officine/:id" element={<TenantDetail />} />
                  <Route path="/audit" element={<AuditLogs />} />
                </Route>
              </Route>

              {/* Fallback redirect */}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </AuthProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </BrowserRouter>
  );
}
```

- [ ] **Step 4: Migrate `PlatformConsole.tsx` (remove chrome + redundant identity)**

The shell now provides the page frame, nav, and identity. In `packages/admin-web/src/pages/PlatformConsole.tsx`:
- Remove the outer `<div className="min-h-screen bg-background p-8"><div className="max-w-5xl mx-auto">` wrapper (and its closing `</div></div>`); the component returns its content directly (metrics grid + chart), wrapped in a single `<div className="space-y-8">`.
- Remove the header block (the `<div className="flex items-center justify-between mb-8">` with the H1 and the Officine/Audit/Crea officina/Esci `<Button>`s).
- Remove the identity `<Card>` (name/email) and the `meQuery` (`/v1/admin/me`) + its error alert — the sidebar `NavUser` now shows identity. Remove the now-unused `displayName`, `useAuth`, `useNavigate`, `Button`, `Card*`, and `AdminMe` imports/interface.
- Keep the metrics query, stat cards, trend chart, loading and metrics-error states.

Resulting return shape:

```tsx
  return (
    <div className="space-y-8">
      {metricsQuery.isLoading && <p className="text-muted-foreground">Caricamento metriche...</p>}

      {metricsQuery.error && (
        <div role="alert" className="p-4 rounded-md bg-destructive/10 text-destructive">
          Errore nel caricamento delle metriche. Riprova.
        </div>
      )}

      {!metricsQuery.isLoading && !metricsQuery.error && metrics && (
        <div className="space-y-8">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
            {/* ...existing StatCard set unchanged... */}
          </div>
          <InterventionsTrendChart data={metrics.trend} />
        </div>
      )}
    </div>
  );
```

- [ ] **Step 5: Migrate `TenantList.tsx`, `TenantDetail.tsx`, `CreateTenant.tsx`, `AuditLogs.tsx`**

Each of these has its page chrome repeated across its loading / error / success branches. For **every** branch in each file, replace the wrapper:

```tsx
<div className="min-h-screen bg-background p-8">
  <div className="max-w-Xxx mx-auto">
    {/* ...branch content... */}
  </div>
</div>
```

with just the content (the shell supplies background + padding). If a branch's content needs a block wrapper, use `<div className="space-y-6">...</div>`; otherwise return the content directly. Per-file wrapper counts (from grep):
- `TenantList.tsx`: 3 wrappers (lines ~155, ~169, ~182) — `max-w-6xl`.
- `TenantDetail.tsx`: 3 wrappers (lines ~245, ~266, ~291) — `max-w-3xl`. Keep the inner content constrained if desired with `max-w-3xl` on the content block (a detail form reads better narrow), but drop `min-h-screen`/`p-8`.
- `CreateTenant.tsx`: 2 wrappers (lines ~84, ~114) — `max-w-2xl`. Keep the form narrow with `max-w-2xl` on the content block; drop `min-h-screen`/`p-8`.
- `AuditLogs.tsx`: 3 wrappers (lines ~107, ~119, ~130) — `max-w-6xl`.

Also remove any inline "back to list" / nav buttons that duplicated shell navigation **only if** they merely navigate between admin pages already in the sidebar; keep contextual actions (e.g. TenantDetail's per-row user actions, "Torna alle officine" back-link is fine to keep as it is contextual). Do NOT remove page-specific action buttons (suspend/reactivate/regenerate/invite/create-submit).

Do not change any data fetching, mutation, or dialog logic.

- [ ] **Step 6: Update `platform-console.test.tsx`**

The inline identity card, the `/v1/admin/me` query, and the Esci button were removed from `PlatformConsole` (they now live in the shell). Edit `packages/admin-web/tests/platform-console.test.tsx`:
- Remove the `mockSignOut` usage and the test `'calls signOut when the Esci button is clicked'` (moved to `app-sidebar.test.tsx`).
- Remove the test `'shows a profile error alert when GET /v1/admin/me fails'` and the `'renders admin identity ...'` assertion on `Mario Rossi`; keep the metric-value assertions (`7`, `420`, trend chart) in the happy-path test, and keep `'shows an error alert when GET /v1/admin/metrics fails'`.
- Simplify `routeApiFetch`/`ME` usage: the component now only calls `/v1/admin/metrics`. Update `mockApiFetch` implementations to resolve metrics (and no longer need the `/v1/admin/me` branch), and drop the now-unused `mockSignOut` from the `useAuth` mock if desired (harmless to keep).

- [ ] **Step 7: Run the full admin-web suite + typecheck + build**

Run:

```bash
pnpm --filter @garageos/admin-web test
pnpm --filter @garageos/admin-web typecheck
pnpm --filter @garageos/admin-web build
```

Expected: all green. Fix any test that still references removed page chrome (e.g. `tenant-list.test.tsx`, `tenant-detail.test.tsx`, `create-tenant.test.tsx`, `AuditLogs.test.tsx` should be unaffected because they query on content, not the wrapper — but if any asserted on a removed nav/back button or on `min-h-screen`, update it to query content).

- [ ] **Step 8: Commit**

```bash
git add packages/admin-web
git commit -m "feat(admin-web): assemble app shell and migrate pages into it"
```

---

## Post-implementation (outside task loop)

- **Whole-branch review:** run `/code-review high` on the branch (final gate for a medium/large single-layer slice).
- **Smoke (mandatory, ship-blocker for shell/layout PRs):** after merge + auto-deploy, browser-smoke `https://admin.garageos.aifollyadvisor.com` with the console open — sidebar nav + active state, collapse/expand persists across reload, NavUser identity + Esci, ThemeToggle flips dark mode and persists, every page renders inside the inset frame, console clean (watch for the Vite `global` shim class of errors).
- **PR2 (content restyle)** is planned separately after PR1 merges.

## Self-Review notes

- **Spec coverage:** shell (Task 3/4/5), inset variant (Task 3 `variant="inset"`), icon-rail collapse + persistence (shadcn `SidebarProvider` cookie, default), NavUser footer (Task 3), dark mode + toggle (Task 2 + Topbar), routing composition (Task 5), page migration/no content restyle (Task 5), tokens/deps/polyfills (Task 1), Tier-2 tests (each task), auth pages outside shell (Task 5 routing). AuthLayout from the spec tree is intentionally NOT created — Login/SetPassword already self-center and stay standalone top-level routes; this is a deliberate YAGNI simplification, noted here.
- **Type consistency:** `titleForPath` name matches between Task 4 def and its test; `AppSidebar`/`NavMain`/`NavUser`/`Topbar`/`AppLayout` names consistent across tasks; `useAuth()` shape (`state.user.{email,givenName,familyName}`, `signOut`) matches `AuthContext.tsx`.
- **No placeholders:** all component code is complete; page migrations reference exact files, line anchors, and the exact wrapper transformation.
