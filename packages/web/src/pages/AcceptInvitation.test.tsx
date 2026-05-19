import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { AcceptInvitation } from './AcceptInvitation';

// ─── Mocks ────────────────────────────────────────────────────────────────────

import * as usersAdminModule from '@/queries/users-admin';
import type { InvitationPublicView } from '@/queries/users-admin';
import { ApiError } from '@/lib/api-client';

// Suppress react-router-dom navigate mock noise
const navigateMock = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TOKEN = 'test-token-abc123';

const mockInvitation: InvitationPublicView = {
  targetEmail: 'mario@officina.test',
  firstName: 'Mario',
  lastName: 'Rossi',
  role: 'mechanic',
  locationName: 'Sede Nord',
  tenantName: 'Officina Rossi',
  expiresAt: '2026-05-26T10:00:00Z',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={[`/invitations/${TOKEN}`]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/invitations/:token" element={ui} />
          <Route path="/login" element={<div>Login page</div>} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const acceptMutateAsyncMock = vi.fn();

function mockHooks({
  invitationData = mockInvitation as InvitationPublicView | undefined,
  isLoading = false,
  isError = false,
  error = null as ApiError | null,
  mutateAsyncFn = acceptMutateAsyncMock,
}: {
  invitationData?: InvitationPublicView | undefined;
  isLoading?: boolean;
  isError?: boolean;
  error?: ApiError | null;
  mutateAsyncFn?: ReturnType<typeof vi.fn>;
} = {}) {
  vi.spyOn(usersAdminModule, 'useInvitation').mockReturnValue({
    data: isError || isLoading ? undefined : invitationData,
    isLoading,
    isError,
    error,
    isPending: isLoading,
    isSuccess: !isLoading && !isError && Boolean(invitationData),
  } as unknown as ReturnType<typeof usersAdminModule.useInvitation>);

  vi.spyOn(usersAdminModule, 'useAcceptInvitation').mockReturnValue({
    mutateAsync: mutateAsyncFn,
    isPending: false,
    isError: false,
    isSuccess: false,
  } as unknown as ReturnType<typeof usersAdminModule.useAcceptInvitation>);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AcceptInvitation page', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    navigateMock.mockClear();
    acceptMutateAsyncMock.mockClear();
  });

  it('shows loading state while the invitation is being fetched', () => {
    mockHooks({ isLoading: true });
    render(wrap(<AcceptInvitation />));
    expect(screen.getByText(/Caricamento invito/i)).toBeInTheDocument();
  });

  it('shows "Invito non valido o scaduto" for a 404 error', () => {
    const notFound = new ApiError('user.invitation.not_found', 404, 'Not found');
    mockHooks({ isError: true, error: notFound });
    render(wrap(<AcceptInvitation />));
    expect(screen.getByText(/Invito non valido o scaduto/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Torna alla home/i })).toBeInTheDocument();
  });

  it('pre-fills read-only invitation details when loaded successfully', () => {
    mockHooks();
    render(wrap(<AcceptInvitation />));
    expect(screen.getByText('Mario Rossi')).toBeInTheDocument();
    expect(screen.getByText('mario@officina.test')).toBeInTheDocument();
    expect(screen.getByText('Meccanico')).toBeInTheDocument();
    expect(screen.getByText('Officina Rossi')).toBeInTheDocument();
    expect(screen.getByText('Sede Nord')).toBeInTheDocument();
  });

  it('does not render Sede row when locationName is null (super_admin role)', () => {
    const superAdminInvitation: InvitationPublicView = {
      ...mockInvitation,
      role: 'super_admin',
      locationName: null,
    };
    mockHooks({ invitationData: superAdminInvitation });
    render(wrap(<AcceptInvitation />));
    expect(screen.queryByText('Sede')).not.toBeInTheDocument();
    expect(screen.getByText('Super Admin')).toBeInTheDocument();
  });

  it('renders password and confirm password inputs', () => {
    mockHooks();
    render(wrap(<AcceptInvitation />));
    expect(screen.getByLabelText(/^Password$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Conferma password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Accetta invito/i })).toBeInTheDocument();
  });

  it('shows validation error when password is shorter than 8 characters', async () => {
    const user = userEvent.setup();
    mockHooks();
    render(wrap(<AcceptInvitation />));

    await user.type(screen.getByLabelText(/^Password$/i), 'short');
    await user.type(screen.getByLabelText(/Conferma password/i), 'short');
    await user.click(screen.getByRole('button', { name: /Accetta invito/i }));

    await waitFor(() => {
      // Verify the red field-error text (distinct from the hint "Almeno 8 caratteri." above the input)
      expect(
        screen.getByText(/La password deve contenere almeno 8 caratteri/i),
      ).toBeInTheDocument();
    });
    expect(acceptMutateAsyncMock).not.toHaveBeenCalled();
  });

  it('shows validation error when passwords do not match', async () => {
    const user = userEvent.setup();
    mockHooks();
    render(wrap(<AcceptInvitation />));

    await user.type(screen.getByLabelText(/^Password$/i), 'password1234');
    await user.type(screen.getByLabelText(/Conferma password/i), 'differentpassword');
    await user.click(screen.getByRole('button', { name: /Accetta invito/i }));

    await waitFor(() => {
      expect(screen.getByText(/password non coincidono/i)).toBeInTheDocument();
    });
    expect(acceptMutateAsyncMock).not.toHaveBeenCalled();
  });

  it('on submit success calls mutateAsync then navigates to /login?invited=1', async () => {
    const user = userEvent.setup();
    acceptMutateAsyncMock.mockResolvedValueOnce(undefined);
    mockHooks({ mutateAsyncFn: acceptMutateAsyncMock });
    render(wrap(<AcceptInvitation />));

    await user.type(screen.getByLabelText(/^Password$/i), 'validpassword99');
    await user.type(screen.getByLabelText(/Conferma password/i), 'validpassword99');
    await user.click(screen.getByRole('button', { name: /Accetta invito/i }));

    await waitFor(() => {
      expect(acceptMutateAsyncMock).toHaveBeenCalledWith({
        token: TOKEN,
        body: { password: 'validpassword99' },
      });
    });
    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith('/login?invited=1', { replace: true });
    });
  });

  it('surfaces password-policy error as inline field error (422)', async () => {
    const user = userEvent.setup();
    const policyError = new ApiError(
      'user.invitation.accept_password_policy',
      422,
      'La password non rispetta la policy.',
    );
    acceptMutateAsyncMock.mockRejectedValueOnce(policyError);
    mockHooks({ mutateAsyncFn: acceptMutateAsyncMock });
    render(wrap(<AcceptInvitation />));

    await user.type(screen.getByLabelText(/^Password$/i), 'weakpassword');
    await user.type(screen.getByLabelText(/Conferma password/i), 'weakpassword');
    await user.click(screen.getByRole('button', { name: /Accetta invito/i }));

    await waitFor(() => {
      expect(screen.getByText(/La password non rispetta la policy/i)).toBeInTheDocument();
    });
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('shows form-level banner for unexpected submit errors', async () => {
    const user = userEvent.setup();
    const serverError = new ApiError('http.500', 500, 'Errore interno del server.');
    acceptMutateAsyncMock.mockRejectedValueOnce(serverError);
    mockHooks({ mutateAsyncFn: acceptMutateAsyncMock });
    render(wrap(<AcceptInvitation />));

    await user.type(screen.getByLabelText(/^Password$/i), 'validpassword99');
    await user.type(screen.getByLabelText(/Conferma password/i), 'validpassword99');
    await user.click(screen.getByRole('button', { name: /Accetta invito/i }));

    await waitFor(() => {
      expect(screen.getByText(/Errore interno del server/i)).toBeInTheDocument();
    });
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
