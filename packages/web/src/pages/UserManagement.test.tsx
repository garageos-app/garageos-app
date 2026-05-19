import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { UserManagement } from './UserManagement';

// ─── Mocks ────────────────────────────────────────────────────────────────────

import * as usersAdminModule from '@/queries/users-admin';
import type { AdminUser, Invitation } from '@/queries/users-admin';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const mockUser: AdminUser = {
  id: crypto.randomUUID(),
  email: 'mario@officina.test',
  firstName: 'Mario',
  lastName: 'Rossi',
  role: 'mechanic',
  locationId: null,
  status: 'active',
  createdAt: '2026-05-19T10:00:00Z',
  deletedAt: null,
};

const mockInvitation: Invitation = {
  id: crypto.randomUUID(),
  targetEmail: 'luigi@officina.test',
  firstName: 'Luigi',
  lastName: 'Verdi',
  role: 'mechanic',
  locationId: null,
  expiresAt: '2026-05-26T10:00:00Z',
  createdAt: '2026-05-19T10:00:00Z',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </MemoryRouter>
  );
}

const revokeMutateMock = vi.fn();

function mockQueries({
  users = [mockUser],
  invitations = [mockInvitation],
  usersLoading = false,
  invsLoading = false,
  usersError = false,
}: {
  users?: AdminUser[];
  invitations?: Invitation[];
  usersLoading?: boolean;
  invsLoading?: boolean;
  usersError?: boolean;
} = {}) {
  vi.spyOn(usersAdminModule, 'useUsers').mockReturnValue({
    data: usersError || usersLoading ? undefined : { users },
    isLoading: usersLoading,
    isError: usersError,
    isSuccess: !usersLoading && !usersError,
    isPending: usersLoading,
  } as unknown as ReturnType<typeof usersAdminModule.useUsers>);

  vi.spyOn(usersAdminModule, 'useInvitations').mockReturnValue({
    data: invsLoading ? undefined : { invitations },
    isLoading: invsLoading,
    isError: false,
    isSuccess: !invsLoading,
    isPending: invsLoading,
  } as unknown as ReturnType<typeof usersAdminModule.useInvitations>);

  vi.spyOn(usersAdminModule, 'useRevokeInvitation').mockReturnValue({
    mutate: revokeMutateMock,
    isPending: false,
    isError: false,
    isSuccess: false,
  } as unknown as ReturnType<typeof usersAdminModule.useRevokeInvitation>);

  // InviteUserDialog is now rendered by UserManagement (T15). Mock both hooks
  // it uses so the dialog renders without AuthProvider or network.
  vi.spyOn(usersAdminModule, 'useInviteUser').mockReturnValue({
    mutateAsync: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof usersAdminModule.useInviteUser>);

  vi.spyOn(usersAdminModule, 'useLocations').mockReturnValue({
    data: { locations: [] },
    isPending: false,
    isError: false,
    isSuccess: true,
  } as unknown as ReturnType<typeof usersAdminModule.useLocations>);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('UserManagement page', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    revokeMutateMock.mockClear();
  });

  it('shows loading state when queries are pending', () => {
    mockQueries({ usersLoading: true, invsLoading: true });
    render(wrap(<UserManagement />));
    expect(screen.getByText('Caricamento...')).toBeInTheDocument();
  });

  it('shows error state when users query fails', () => {
    mockQueries({ usersError: true });
    render(wrap(<UserManagement />));
    expect(screen.getByText('Errore caricamento utenti.')).toBeInTheDocument();
  });

  it('renders the Invita utente button', () => {
    mockQueries();
    render(wrap(<UserManagement />));
    expect(screen.getByRole('button', { name: 'Invita utente' })).toBeInTheDocument();
  });

  it('renders users in the active users section', () => {
    mockQueries();
    render(wrap(<UserManagement />));
    expect(screen.getByText('Mario Rossi')).toBeInTheDocument();
    expect(screen.getByText(/mario@officina\.test/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Modifica' })).toBeInTheDocument();
  });

  it('renders pending invitations with Revoca button', () => {
    mockQueries();
    render(wrap(<UserManagement />));
    expect(screen.getByText('Luigi Verdi')).toBeInTheDocument();
    expect(screen.getByText(/luigi@officina\.test/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoca' })).toBeInTheDocument();
  });

  it('shows empty state when there are no pending invitations', () => {
    mockQueries({ invitations: [] });
    render(wrap(<UserManagement />));
    expect(screen.getByText('Nessun invito pendente.')).toBeInTheDocument();
  });

  it('clicking Revoca calls useRevokeInvitation.mutate with invitation id', async () => {
    const user = userEvent.setup();
    mockQueries();
    render(wrap(<UserManagement />));

    await user.click(screen.getByRole('button', { name: 'Revoca' }));

    await waitFor(() => {
      expect(revokeMutateMock).toHaveBeenCalledWith(mockInvitation.id);
    });
  });
});
