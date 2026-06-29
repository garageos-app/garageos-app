import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TenantDetail } from '@/pages/TenantDetail';
import type { TenantProfile, AdminUser } from '@/lib/tenant-detail-types';

// Hoist shared mocks so they are available inside vi.mock factory closures.
// ApiError is re-implemented here so that both the component (which imports it
// from the mocked module) and the test (which uses it directly) share the same
// class reference — preserving instanceof checks inside TenantDetail.tsx.
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

// Wrap in MemoryRouter + Routes so useParams returns the correct id.
function makeWrapper(tenantId = 'tenant-001') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[`/officine/${tenantId}`]}>
          <Routes>
            {/* children is the <TenantDetail /> element rendered by RTL */}
            <Route path="/officine/:id" element={<>{children}</>} />
            {/* Back-link target — prevents "no match" warning from react-router */}
            <Route path="/officine" element={<div />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

const TENANT_PROFILE: TenantProfile = {
  id: 'tenant-001',
  businessName: 'Officina Bianchi SRL',
  vatNumber: '12345678901',
  email: 'info@bianchi.it',
  phone: '+39 02 1234567',
  addressLine: 'Via Roma 1',
  city: 'Milano',
  province: 'MI',
  postalCode: '20100',
  status: 'active',
  plan: 'standard',
  billingStatus: 'active',
  createdAt: '2026-01-15T10:00:00.000Z',
  onboardingCompletedAt: null,
};

// ── B3 fixtures ──────────────────────────────────────────────────────────────

const USER_ACTIVE: AdminUser = {
  id: 'user-001',
  email: 'mario@bianchi.it',
  firstName: 'Mario',
  lastName: 'Rossi',
  role: 'super_admin',
  locationId: null,
  status: 'active',
  phone: null,
  avatarUrl: null,
  lastLoginAt: null,
  createdAt: '2026-01-15T10:00:00.000Z',
  updatedAt: '2026-01-15T10:00:00.000Z',
  deletedAt: null,
};

const USER_INACTIVE: AdminUser = {
  id: 'user-002',
  email: 'luigi@bianchi.it',
  firstName: 'Luigi',
  lastName: 'Bianchi',
  role: 'mechanic',
  locationId: null,
  status: 'inactive',
  phone: null,
  avatarUrl: null,
  lastLoginAt: null,
  createdAt: '2026-02-10T10:00:00.000Z',
  updatedAt: '2026-02-10T10:00:00.000Z',
  deletedAt: null,
};

beforeEach(() => {
  mockApiFetch.mockReset();
});

describe('TenantDetail page', () => {
  it('happy path: businessName and vatNumber are populated in form fields', async () => {
    mockApiFetch.mockResolvedValueOnce({ tenant: TENANT_PROFILE });

    render(<TenantDetail />, { wrapper: makeWrapper() });

    // Wait for the form to be populated from the query response.
    expect(await screen.findByDisplayValue('Officina Bianchi SRL')).toBeInTheDocument();
    expect(screen.getByDisplayValue('12345678901')).toBeInTheDocument();
  });

  it('error state: apiFetch rejects and the error alert renders', async () => {
    mockApiFetch.mockRejectedValueOnce(new Error('Network error'));

    render(<TenantDetail />, { wrapper: makeWrapper() });

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  // ── B3: Users section ──────────────────────────────────────────────────────

  it('users section: renders two users from the query', async () => {
    // Route by path: profile query vs. users list query.
    mockApiFetch.mockImplementation((path: string) => {
      if (typeof path === 'string' && path.endsWith('/users')) {
        return Promise.resolve({ users: [USER_ACTIVE, USER_INACTIVE] });
      }
      return Promise.resolve({ tenant: TENANT_PROFILE });
    });

    render(<TenantDetail />, { wrapper: makeWrapper() });

    // Full names are derived from firstName + lastName in the table rows.
    expect(await screen.findByText('Mario Rossi')).toBeInTheDocument();
    expect(screen.getByText('Luigi Bianchi')).toBeInTheDocument();
  });

  it('action gating: Disabilita shows for active user; Riattiva shows for inactive user', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (typeof path === 'string' && path.endsWith('/users')) {
        return Promise.resolve({ users: [USER_ACTIVE, USER_INACTIVE] });
      }
      return Promise.resolve({ tenant: TENANT_PROFILE });
    });

    render(<TenantDetail />, { wrapper: makeWrapper() });

    // Wait for both rows to appear.
    await screen.findByText('Mario Rossi');

    // Active user (USER_ACTIVE) shows Disabilita, not Riattiva.
    expect(screen.getByRole('button', { name: /disabilita/i })).toBeInTheDocument();
    // Inactive user (USER_INACTIVE) shows Riattiva, not Disabilita.
    expect(screen.getByRole('button', { name: /riattiva/i })).toBeInTheDocument();
  });

  it('invite dialog: submitting the form calls POST /invitations with the correct body', async () => {
    const INVITE_URL = 'https://app.garageos.example.com/inv/tok123';

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      // Invite POST — must match before the /users catch-all below.
      if (init?.method === 'POST' && typeof path === 'string' && path.includes('/invitations')) {
        return Promise.resolve({
          invitation: {
            email: 'nuovo@officina.it',
            role: 'mechanic',
            expiresAt: '2026-07-06T10:00:00.000Z',
            emailSent: true,
            magicLinkUrl: INVITE_URL,
          },
        });
      }
      // Users list GET.
      if (typeof path === 'string' && path.endsWith('/users')) {
        return Promise.resolve({ users: [] });
      }
      // Tenant profile GET.
      return Promise.resolve({ tenant: TENANT_PROFILE });
    });

    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();

    render(<TenantDetail />, { wrapper: makeWrapper() });

    // Wait for the profile form to be populated before interacting.
    await screen.findByDisplayValue('Officina Bianchi SRL');

    // Open the invite dialog.
    await user.click(screen.getByRole('button', { name: /invita utente/i }));

    // Scope all interactions within the dialog to avoid ambiguity with profile
    // form fields that share label names (e.g. "Email").
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Email'), 'nuovo@officina.it');
    await user.type(within(dialog).getByLabelText('Nome'), 'Carlo');
    await user.type(within(dialog).getByLabelText('Cognome'), 'Verdi');
    // role stays at the default 'mechanic'.

    await user.click(within(dialog).getByRole('button', { name: /^invita$/i }));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/v1/admin/tenants/tenant-001/users/invitations',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            email: 'nuovo@officina.it',
            firstName: 'Carlo',
            lastName: 'Verdi',
            role: 'mechanic',
          }),
        }),
      );
    });
  });
});
