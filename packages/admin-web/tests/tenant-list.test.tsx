import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TenantList } from '@/pages/TenantList';
import type { TenantAdminListItem } from '@/lib/tenant-types';

// Mock useApiFetch so tests control the API response without real network or
// Cognito dependencies.
const { mockApiFetch } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({
  useApiFetch: () => mockApiFetch,
  ApiError: class ApiError extends Error {
    readonly code: string;
    readonly status: number;
    constructor(code: string, status: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.code = code;
      this.status = status;
    }
  },
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

// Active tenant whose owner has already accepted the invitation — Rigenera link
// must NOT appear for this row.
const TENANT_ACTIVE_ACCEPTED_OWNER: TenantAdminListItem = {
  id: 'tenant-003',
  businessName: 'Garage Verdi SRL',
  vatNumber: '11223344556',
  email: 'info@verdi.it',
  status: 'active',
  createdAt: '2026-03-10T08:00:00.000Z',
  owner: { email: 'anna@verdi.it', invitationStatus: 'accepted' },
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

  // ── T8: action gating ───────────────────────────────────────────────────────

  it('action gating: active+pending-owner row shows Sospendi and Rigenera link, not Riattiva', async () => {
    mockApiFetch.mockResolvedValueOnce({ tenants: [TENANT_ACTIVE] });

    render(<TenantList />, { wrapper: makeWrapper() });
    await screen.findByText('Officina Bianchi SRL');

    // Sospendi and Rigenera link must be present
    expect(screen.getByRole('button', { name: /sospendi/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /rigenera link/i })).toBeInTheDocument();
    // Riattiva must NOT appear
    expect(screen.queryByRole('button', { name: /riattiva/i })).not.toBeInTheDocument();
  });

  it('action gating: suspended row shows Riattiva only (no Sospendi, no Rigenera link)', async () => {
    mockApiFetch.mockResolvedValueOnce({ tenants: [TENANT_SUSPENDED] });

    render(<TenantList />, { wrapper: makeWrapper() });
    await screen.findByText('Autofficina Rossi SNC');

    // Riattiva must be present
    expect(screen.getByRole('button', { name: /riattiva/i })).toBeInTheDocument();
    // Sospendi and Rigenera link must NOT appear
    expect(screen.queryByRole('button', { name: /sospendi/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /rigenera link/i })).not.toBeInTheDocument();
  });

  it('action gating: active+accepted-owner row shows Sospendi but NOT Rigenera link', async () => {
    mockApiFetch.mockResolvedValueOnce({ tenants: [TENANT_ACTIVE_ACCEPTED_OWNER] });

    render(<TenantList />, { wrapper: makeWrapper() });
    await screen.findByText('Garage Verdi SRL');

    expect(screen.getByRole('button', { name: /sospendi/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /rigenera link/i })).not.toBeInTheDocument();
  });

  // ── Fix 1: empty JSON body regression ─────────────────────────────────────
  // Guards against FST_ERR_CTP_EMPTY_JSON_BODY (400) on lifecycle POSTs.
  // api-client sets Content-Type: application/json unconditionally, so Fastify
  // rejects a bodyless POST before the handler runs. Every mutation must send '{}'.

  it('Fix 1 — suspend mutation sends body: JSON.stringify({})', async () => {
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (init?.method === 'POST' && typeof path === 'string' && path.includes('/suspend')) {
        return Promise.resolve({ tenant: { id: 'tenant-001', status: 'suspended' } });
      }
      return Promise.resolve({ tenants: [TENANT_ACTIVE] });
    });

    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();

    render(<TenantList />, { wrapper: makeWrapper() });
    await screen.findByText('Officina Bianchi SRL');

    // Open the confirm dialog (row button)
    await user.click(screen.getByRole('button', { name: /sospendi/i }));
    // Scope the confirm click to the alertdialog to avoid ambiguity with the row button
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /sospendi/i }));

    // Verify the mutation was called with the correct body
    expect(mockApiFetch).toHaveBeenCalledWith(
      `/v1/admin/tenants/${TENANT_ACTIVE.id}/suspend`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({}) }),
    );
  });

  it('Fix 1 — reactivate mutation sends body: JSON.stringify({})', async () => {
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (init?.method === 'POST' && typeof path === 'string' && path.includes('/reactivate')) {
        return Promise.resolve({ tenant: { id: 'tenant-002', status: 'active' } });
      }
      return Promise.resolve({ tenants: [TENANT_SUSPENDED] });
    });

    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();

    render(<TenantList />, { wrapper: makeWrapper() });
    await screen.findByText('Autofficina Rossi SNC');

    // Open the confirm dialog (row button)
    await user.click(screen.getByRole('button', { name: /riattiva/i }));
    // Scope the confirm click to the alertdialog
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /riattiva/i }));

    expect(mockApiFetch).toHaveBeenCalledWith(
      `/v1/admin/tenants/${TENANT_SUSPENDED.id}/reactivate`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({}) }),
    );
  });

  it('Fix 1 — regenerate mutation sends body: JSON.stringify({})', async () => {
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (
        init?.method === 'POST' &&
        typeof path === 'string' &&
        path.includes('regenerate-invitation')
      ) {
        return Promise.resolve({
          invitation: {
            ownerEmail: 'mario@bianchi.it',
            expiresAt: '2026-07-06T10:00:00.000Z',
            emailSent: true,
            magicLinkUrl: 'https://app.garageos.example.com/invitations/tok_fix1',
          },
        });
      }
      return Promise.resolve({ tenants: [TENANT_ACTIVE] });
    });

    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();

    render(<TenantList />, { wrapper: makeWrapper() });
    await screen.findByText('Officina Bianchi SRL');

    await user.click(screen.getByRole('button', { name: /rigenera link/i }));

    expect(mockApiFetch).toHaveBeenCalledWith(
      `/v1/admin/tenants/${TENANT_ACTIVE.id}/regenerate-invitation`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({}) }),
    );
  });

  // ── T8: regenerate success dialog ──────────────────────────────────────────

  it('regenerate success: clicking Rigenera link opens dialog with magicLinkUrl', async () => {
    const magicLinkUrl = 'https://app.garageos.aifollyadvisor.com/invitations/tok_abc123';

    // mockImplementation disambiguates list query vs. mutation by path/method
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (
        init?.method === 'POST' &&
        typeof path === 'string' &&
        path.includes('regenerate-invitation')
      ) {
        return Promise.resolve({
          invitation: {
            ownerEmail: 'mario@bianchi.it',
            expiresAt: '2026-07-06T10:00:00.000Z',
            emailSent: true,
            magicLinkUrl,
          },
        });
      }
      // List query and any refetch
      return Promise.resolve({ tenants: [TENANT_ACTIVE] });
    });

    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();

    render(<TenantList />, { wrapper: makeWrapper() });
    await screen.findByText('Officina Bianchi SRL');

    // Click the Rigenera link button
    await user.click(screen.getByRole('button', { name: /rigenera link/i }));

    // Result dialog must appear with the URL
    expect(await screen.findByDisplayValue(magicLinkUrl)).toBeInTheDocument();
    // emailSent=true → "Email inviata" note
    expect(screen.getByText(/email inviata a mario@bianchi\.it/i)).toBeInTheDocument();
  });
});
