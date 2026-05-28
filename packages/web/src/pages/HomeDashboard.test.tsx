import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { HomeDashboard } from './HomeDashboard';
import { AuthProvider } from '@/auth/AuthContext';
import { useDisputesOpen } from '@/queries/disputesOpen';

vi.mock('@/queries/deadlinesUpcoming', () => ({
  useDeadlinesUpcoming: vi.fn(() => ({ isLoading: false, isError: false, data: [] })),
}));

vi.mock('@/queries/interventionsRecent', () => ({
  useInterventionsRecent: vi.fn(() => ({ isLoading: false, isError: false, data: [] })),
}));

vi.mock('@/queries/disputesOpen');

const mockedUseDisputesOpen = vi.mocked(useDisputesOpen);

function renderHome() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <MemoryRouter>
          <HomeDashboard />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe('<HomeDashboard />', () => {
  it('renders all 3 card headings: Scadenze, Ultimi interventi, Contestazioni', () => {
    mockedUseDisputesOpen.mockReturnValue({
      data: {
        pendingResponse: { count: 0, items: [] },
        inProgress: { count: 0, items: [] },
      },
      isLoading: false,
      isError: false,
    } as never);
    renderHome();
    expect(screen.getByRole('heading', { name: 'Scadenze prossimi 7 giorni' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ultimi interventi' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Contestazioni' })).toBeInTheDocument();
  });

  it('renders DisputeBanner when pendingResponse.count > 0', () => {
    mockedUseDisputesOpen.mockReturnValue({
      data: {
        pendingResponse: { count: 2, items: [] },
        inProgress: { count: 0, items: [] },
      },
      isLoading: false,
      isError: false,
    } as never);
    renderHome();
    expect(screen.getByTestId('dispute-banner')).toBeInTheDocument();
  });

  it('does not render DisputeBanner when pendingResponse.count = 0', () => {
    mockedUseDisputesOpen.mockReturnValue({
      data: {
        pendingResponse: { count: 0, items: [] },
        inProgress: { count: 3, items: [] },
      },
      isLoading: false,
      isError: false,
    } as never);
    renderHome();
    expect(screen.queryByTestId('dispute-banner')).not.toBeInTheDocument();
  });
});
