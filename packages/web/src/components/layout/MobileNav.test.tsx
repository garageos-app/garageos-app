import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AppLayout } from './AppLayout';
import { AuthContext, type AuthContextValue } from '@/auth/AuthContext';

// useProfileMe hits react-query; stub it so TopBar renders without a real client.
vi.mock('@/queries/profileMe', () => ({
  useProfileMe: () => ({ data: undefined }),
}));

// LocationFilterProvider calls useLocations (react-query); stub the whole context
// module so AppLayout doesn't need a real server or real query infrastructure.
vi.mock('@/location-filter/LocationFilterContext', () => ({
  LocationFilterProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// LocationSelector is stubbed — its own behavior is covered elsewhere.
vi.mock('@/location-filter/LocationSelector', () => ({
  LocationSelector: () => null,
}));

// ThemeToggle is irrelevant for these tests.
vi.mock('@/theme/ThemeToggle', () => ({
  ThemeToggle: () => null,
}));

const mockAuth = (overrides: Partial<AuthContextValue> = {}): AuthContextValue => ({
  state: { status: 'authenticated', user: { email: 'm@x.com' } },
  signIn: vi.fn(),
  signOut: vi.fn(),
  getIdToken: vi.fn().mockResolvedValue('jwt'),
  ...overrides,
});

function renderLayout() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthContext.Provider value={mockAuth()}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route element={<AppLayout />}>
              <Route path="/" element={<div>home content</div>} />
              <Route path="/customers" element={<div>customers content</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

describe('AppLayout mobile drawer', () => {
  it('opens the nav drawer from the hamburger', async () => {
    renderLayout();
    // Drawer not mounted until opened (Radix only mounts SheetContent while open)
    expect(screen.queryByTestId('mobile-drawer')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /apri menu/i }));
    const drawer = await screen.findByTestId('mobile-drawer');
    expect(within(drawer).getByRole('link', { name: /clienti/i })).toBeInTheDocument();
  });

  it('closes the drawer when a nav link is clicked', async () => {
    renderLayout();
    await userEvent.click(screen.getByRole('button', { name: /apri menu/i }));
    const drawer = await screen.findByTestId('mobile-drawer');
    const link = within(drawer).getByRole('link', { name: /clienti/i });
    await userEvent.click(link);
    // After navigation the drawer closes → SheetContent unmounted from DOM
    expect(screen.queryByTestId('mobile-drawer')).not.toBeInTheDocument();
  });
});
