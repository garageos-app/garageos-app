import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { HomeDashboard } from './HomeDashboard';
import { AuthProvider } from '@/auth/AuthContext';

vi.mock('@/queries/deadlinesUpcoming', () => ({
  useDeadlinesUpcoming: vi.fn(() => ({ isLoading: false, isError: false, data: [] })),
}));

vi.mock('@/queries/interventionsRecent', () => ({
  useInterventionsRecent: vi.fn(() => ({ isLoading: false, isError: false, data: [] })),
}));

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
  it('renders all 3 cards: Scadenze, Ultimi interventi, Contestazioni', () => {
    renderHome();
    expect(screen.getByRole('heading', { name: 'Scadenze prossimi 7 giorni' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ultimi interventi' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Contestazioni' })).toBeInTheDocument();
  });

  it('shows "In arrivo nel prossimo PR" label on the Contestazioni placeholder', () => {
    renderHome();
    const labels = screen.getAllByText('In arrivo nel prossimo PR');
    expect(labels.length).toBe(1);
  });
});
