import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TenantList } from '@/pages/TenantList';
import type { TenantAdminListItem } from '@/pages/TenantList';

// Mock useApiFetch so tests control the API response without real network or
// Cognito dependencies.
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

// Each test gets a fresh QueryClient to prevent cross-test cache bleed.
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

const TENANT_ACTIVE: TenantAdminListItem = {
  id: 'tenant-001',
  businessName: 'Officina Bianchi SRL',
  vatNumber: '12345678901',
  email: 'info@bianchi.it',
  status: 'active',
  createdAt: '2026-01-15T10:00:00.000Z',
  owner: { email: 'mario@bianchi.it', invitationStatus: 'pending' },
};

const TENANT_SUSPENDED: TenantAdminListItem = {
  id: 'tenant-002',
  businessName: 'Autofficina Rossi SNC',
  vatNumber: '98765432109',
  email: 'info@rossi.it',
  status: 'suspended',
  createdAt: '2026-02-20T14:00:00.000Z',
  owner: { email: 'luigi@rossi.it', invitationStatus: 'accepted' },
};

beforeEach(() => {
  mockApiFetch.mockReset();
});

describe('TenantList page', () => {
  it('happy path: renders two tenant rows with correct Stato and Invito labels', async () => {
    mockApiFetch.mockResolvedValueOnce({ tenants: [TENANT_ACTIVE, TENANT_SUSPENDED] });

    render(<TenantList />, { wrapper: makeWrapper() });

    // Both business names appear
    expect(await screen.findByText('Officina Bianchi SRL')).toBeInTheDocument();
    expect(screen.getByText('Autofficina Rossi SNC')).toBeInTheDocument();

    // Stato badges: Attiva and Sospesa
    expect(screen.getByText('Attiva')).toBeInTheDocument();
    expect(screen.getByText('Sospesa')).toBeInTheDocument();

    // Invito badges: In attesa and Accettato
    expect(screen.getByText('In attesa')).toBeInTheDocument();
    expect(screen.getByText('Accettato')).toBeInTheDocument();
  });

  it('filter gating: selecting "Sospese" hides the active row', async () => {
    mockApiFetch.mockResolvedValueOnce({ tenants: [TENANT_ACTIVE, TENANT_SUSPENDED] });

    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();

    render(<TenantList />, { wrapper: makeWrapper() });

    // Wait for data to load
    await screen.findByText('Officina Bianchi SRL');

    // Click the "Sospese" filter button
    await user.click(screen.getByRole('button', { name: /sospese/i }));

    // Active tenant should be hidden
    expect(screen.queryByText('Officina Bianchi SRL')).not.toBeInTheDocument();
    // Suspended tenant should still be visible
    expect(screen.getByText('Autofficina Rossi SNC')).toBeInTheDocument();
  });

  it('error state: apiFetch rejects and the error alert renders', async () => {
    mockApiFetch.mockRejectedValueOnce(new Error('Network error'));

    render(<TenantList />, { wrapper: makeWrapper() });

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Errore nel caricamento delle officine.');
  });
});
