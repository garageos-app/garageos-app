import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PlatformConsole } from '@/pages/PlatformConsole';

// Mock useApiFetch so tests control the API response without real network or
// Cognito dependencies.
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

beforeEach(() => {
  mockApiFetch.mockReset();
  mockSignOut.mockReset();
});

describe('PlatformConsole page', () => {
  it('renders admin identity from mocked GET /v1/admin/me', async () => {
    mockApiFetch.mockResolvedValueOnce({
      id: 'admin-id',
      email: 'admin@garageos.it',
      givenName: 'Mario',
      familyName: 'Rossi',
    });

    render(<PlatformConsole />, { wrapper: makeWrapper() });

    // Display name composed from given + family name
    expect(await screen.findByText('Mario Rossi')).toBeInTheDocument();
    // Email shown in the card body
    expect(await screen.findByText('admin@garageos.it')).toBeInTheDocument();
  });

  it('shows an error alert when GET /v1/admin/me fails', async () => {
    mockApiFetch.mockRejectedValueOnce(new Error('Network error'));

    render(<PlatformConsole />, { wrapper: makeWrapper() });

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});
