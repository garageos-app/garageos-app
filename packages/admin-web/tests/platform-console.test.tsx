import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PlatformConsole } from '@/pages/PlatformConsole';
import type { PlatformMetrics } from '@/lib/metrics-types';

const { mockApiFetch, mockSignOut } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
  mockSignOut: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({
  useApiFetch: () => mockApiFetch,
}));

vi.mock('@/auth/useAuth', () => ({
  useAuth: () => ({
    signOut: mockSignOut,
    state: { status: 'authenticated', user: { email: 'admin@garageos.it' } },
    signIn: vi.fn(),
    getIdToken: vi.fn(),
    completeNewPassword: vi.fn(),
  }),
}));

const ME = {
  sub: 'sub-abc123',
  email: 'admin@garageos.it',
  firstName: 'Mario',
  lastName: 'Rossi',
};

const METRICS: PlatformMetrics = {
  tenants: { total: 7, active: 5, suspended: 2 },
  usersTotal: 19,
  interventions: { total: 420, last30d: 33 },
  vehiclesTotal: 88,
  customersTotal: 64,
  trend: Array.from({ length: 8 }, (_, i) => ({
    week: `2026-05-${String(5 + i).padStart(2, '0')}`,
    count: i,
  })),
};

// Route the mock by path so both queries (me + metrics) resolve.
function routeApiFetch(overrides?: { me?: unknown; metrics?: unknown }) {
  mockApiFetch.mockImplementation((path: string) => {
    if (path === '/v1/admin/me') return Promise.resolve(overrides?.me ?? ME);
    if (path === '/v1/admin/metrics') return Promise.resolve(overrides?.metrics ?? METRICS);
    return Promise.reject(new Error(`unexpected path ${path}`));
  });
}

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

beforeEach(() => {
  mockApiFetch.mockReset();
  mockSignOut.mockReset();
});

describe('PlatformConsole page', () => {
  it('renders admin identity and aggregate metric values', async () => {
    routeApiFetch();
    render(<PlatformConsole />, { wrapper: makeWrapper() });

    expect(await screen.findByText('Mario Rossi')).toBeInTheDocument();
    // Tenants total + interventions total surface as stat-card values.
    expect(await screen.findByText('7')).toBeInTheDocument();
    expect(await screen.findByText('420')).toBeInTheDocument();
    // Trend chart container is rendered.
    expect(screen.getByTestId('trend-chart')).toBeInTheDocument();
  });

  it('shows an error alert when GET /v1/admin/metrics fails', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/admin/me') return Promise.resolve(ME);
      return Promise.reject(new Error('Network error'));
    });
    render(<PlatformConsole />, { wrapper: makeWrapper() });

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('shows a profile error alert when GET /v1/admin/me fails', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/admin/me') return Promise.reject(new Error('profile error'));
      if (path === '/v1/admin/metrics') return Promise.resolve(METRICS);
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    render(<PlatformConsole />, { wrapper: makeWrapper() });

    expect(
      await screen.findByText('Errore nel caricamento del profilo. Riprova.'),
    ).toBeInTheDocument();
  });

  it('calls signOut when the Esci button is clicked', async () => {
    routeApiFetch();
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    render(<PlatformConsole />, { wrapper: makeWrapper() });

    await screen.findByText('Mario Rossi');
    await user.click(screen.getByRole('button', { name: /esci/i }));
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });
});
