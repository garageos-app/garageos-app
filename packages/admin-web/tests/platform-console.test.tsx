import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PlatformConsole } from '@/pages/PlatformConsole';
import type { PlatformMetrics } from '@/lib/metrics-types';

const { mockApiFetch } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({
  useApiFetch: () => mockApiFetch,
}));

vi.mock('@/auth/useAuth', () => ({
  useAuth: () => ({
    signOut: vi.fn(),
    state: { status: 'authenticated', user: { email: 'admin@garageos.it' } },
    signIn: vi.fn(),
    getIdToken: vi.fn(),
    completeNewPassword: vi.fn(),
  }),
}));

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

// Route the mock by path — the component now only calls /v1/admin/metrics.
function routeApiFetch(overrides?: { metrics?: unknown }) {
  mockApiFetch.mockImplementation((path: string) => {
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
});

describe('PlatformConsole page', () => {
  it('renders aggregate metric values', async () => {
    routeApiFetch();
    render(<PlatformConsole />, { wrapper: makeWrapper() });

    // Tenants total + interventions total surface as stat-card values.
    expect(await screen.findByText('7')).toBeInTheDocument();
    expect(await screen.findByText('420')).toBeInTheDocument();
    // Trend chart container is rendered.
    expect(screen.getByTestId('trend-chart')).toBeInTheDocument();
  });

  it('shows an error alert when GET /v1/admin/metrics fails', async () => {
    mockApiFetch.mockImplementation(() => Promise.reject(new Error('Network error')));
    render(<PlatformConsole />, { wrapper: makeWrapper() });

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('shows skeleton cards while metrics are loading', () => {
    // Never resolve — keep the query in loading state.
    mockApiFetch.mockImplementation(() => new Promise(() => {}));
    const { container } = render(<PlatformConsole />, { wrapper: makeWrapper() });
    // 5 stat-card skeletons render while loading.
    expect(container.querySelectorAll('[data-testid="stat-skeleton"]').length).toBe(5);
  });
});
