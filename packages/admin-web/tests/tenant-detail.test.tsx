import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TenantDetail } from '@/pages/TenantDetail';
import type { TenantProfile } from '@/lib/tenant-detail-types';

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
});
