// EditUserDialog tests — F-OFF-004
//
// Per memory feedback_radix_tabs_user_event_not_fire_event: Radix Select
// portals do not open in JSDOM via fireEvent — use userEvent.click().
//
// Test cases:
//   1. BR-203: last_super_admin 409 server error surfaces as inline banner on role section.
//   2. Deactivate two-step confirm: first click shows confirm; second click calls useDeleteUser.
//   3. Successful role change calls useUpdateUser and closes dialog.
//   4. Annulla (deactivate confirm) cancels the confirm step without calling useDeleteUser.
//   5. Dialog does not render content when open=false.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { ApiError } from '@/lib/api-client';
import type { AdminUser } from '@/queries/users-admin';
import { EditUserDialog } from './EditUserDialog';

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const {
  mockUpdateMutateAsync,
  mockDeleteMutateAsync,
  mockDeleteIsPending,
  mockToastSuccess,
  mockToastError,
  mockUseLocations,
} = vi.hoisted(() => ({
  mockUpdateMutateAsync: vi.fn(),
  mockDeleteMutateAsync: vi.fn(),
  mockDeleteIsPending: { value: false },
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
  mockUseLocations: vi.fn(),
}));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
  return {
    ...actual,
    useApiFetch: () => vi.fn(),
  };
});

vi.mock('sonner', () => ({
  toast: { success: mockToastSuccess, error: mockToastError },
}));

// Module-level mock for useUpdateUser, useDeleteUser, useLocations.
vi.mock('@/queries/users-admin', async () => {
  const actual =
    await vi.importActual<typeof import('@/queries/users-admin')>('@/queries/users-admin');
  return {
    ...actual,
    useUpdateUser: () => ({
      mutateAsync: mockUpdateMutateAsync,
      isPending: false,
    }),
    useDeleteUser: () => ({
      mutateAsync: mockDeleteMutateAsync,
      isPending: mockDeleteIsPending.value,
    }),
    useLocations: mockUseLocations,
  };
});

// ─── Test helpers ─────────────────────────────────────────────────────────────

function wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const LOCATIONS = [
  { id: 'loc-1', name: 'Officina Nord', city: 'Milano', isPrimary: true },
  { id: 'loc-2', name: 'Officina Sud', city: 'Roma', isPrimary: false },
];

const SUPER_ADMIN_USER: AdminUser = {
  id: 'user-super-1',
  email: 'admin@officina.it',
  firstName: 'Anna',
  lastName: 'Verdi',
  role: 'super_admin',
  locationId: null,
  status: 'active',
  createdAt: '2026-01-01T00:00:00Z',
  deletedAt: null,
};

const MECHANIC_USER: AdminUser = {
  id: 'user-mech-1',
  email: 'meccanico@officina.it',
  firstName: 'Marco',
  lastName: 'Rossi',
  role: 'mechanic',
  locationId: 'loc-1',
  status: 'active',
  createdAt: '2026-01-01T00:00:00Z',
  deletedAt: null,
};

// ─── UI Tests ─────────────────────────────────────────────────────────────────

describe('EditUserDialog UI', () => {
  beforeEach(() => {
    mockUpdateMutateAsync.mockReset();
    mockDeleteMutateAsync.mockReset();
    mockDeleteIsPending.value = false;
    mockToastSuccess.mockReset();
    mockToastError.mockReset();
    mockUseLocations.mockReturnValue({
      data: { locations: LOCATIONS },
      isPending: false,
      isError: false,
    });
  });

  // ── Dialog visibility ──────────────────────────────────────────────────────

  it('does not render content when open=false', () => {
    render(<EditUserDialog user={SUPER_ADMIN_USER} open={false} onOpenChange={() => {}} />, {
      wrapper: wrap,
    });
    expect(screen.queryByText(/modifica utente/i)).not.toBeInTheDocument();
  });

  it('renders dialog title with user name when open=true', () => {
    render(<EditUserDialog user={SUPER_ADMIN_USER} open={true} onOpenChange={() => {}} />, {
      wrapper: wrap,
    });
    expect(screen.getByText(/modifica utente/i)).toBeInTheDocument();
    expect(screen.getByText('Anna Verdi', { exact: false })).toBeInTheDocument();
    expect(screen.getByText(SUPER_ADMIN_USER.email)).toBeInTheDocument();
  });

  it('renders the three action sections', () => {
    render(<EditUserDialog user={SUPER_ADMIN_USER} open={true} onOpenChange={() => {}} />, {
      wrapper: wrap,
    });
    expect(screen.getByText('Cambia ruolo')).toBeInTheDocument();
    expect(screen.getByText('Cambia sede')).toBeInTheDocument();
    // "Disattiva utente" is the section heading (h3) AND the button text.
    // Confirm both are present via testid for the button.
    expect(screen.getByTestId('deactivate-button')).toBeInTheDocument();
  });

  // ── Chiudi button ──────────────────────────────────────────────────────────

  it('Chiudi button invokes onOpenChange(false)', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<EditUserDialog user={SUPER_ADMIN_USER} open={true} onOpenChange={onOpenChange} />, {
      wrapper: wrap,
    });

    await user.click(screen.getByRole('button', { name: /chiudi/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  // ── BR-203: last super admin 409 → inline banner ───────────────────────────

  it('BR-203: 409 user.last_super_admin error surfaces as role section inline banner', async () => {
    // Arrange: mutateAsync rejects with a 409 ApiError.
    mockUpdateMutateAsync.mockRejectedValue(
      new ApiError('user.last_super_admin', 409, "Non puoi rimuovere l'ultimo amministratore."),
    );

    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    render(<EditUserDialog user={SUPER_ADMIN_USER} open={true} onOpenChange={onOpenChange} />, {
      wrapper: wrap,
    });

    // Submit the Change Role form directly — the role is already set to
    // super_admin, so Zod validation passes. Click "Salva ruolo" button.
    await user.click(screen.getByRole('button', { name: /salva ruolo/i }));

    // The inline banner should appear in the role section.
    await waitFor(() => {
      expect(screen.getByTestId('role-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('role-error')).toHaveTextContent(
      /Non puoi rimuovere l.+ultimo amministratore/i,
    );
    // Dialog must NOT have been closed.
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  // ── Deactivate two-step confirm ────────────────────────────────────────────

  it('first click on "Disattiva utente" shows confirm step, NOT calls useDeleteUser', async () => {
    const user = userEvent.setup();
    render(<EditUserDialog user={SUPER_ADMIN_USER} open={true} onOpenChange={() => {}} />, {
      wrapper: wrap,
    });

    await user.click(screen.getByTestId('deactivate-button'));

    // Confirm prompt should appear.
    expect(screen.getByText(/sei sicuro/i)).toBeInTheDocument();
    expect(screen.getByTestId('deactivate-confirm-button')).toBeInTheDocument();

    // Mutation must NOT have been called yet.
    expect(mockDeleteMutateAsync).not.toHaveBeenCalled();
  });

  it('second click on confirm button calls useDeleteUser with user.id', async () => {
    const user = userEvent.setup();
    mockDeleteMutateAsync.mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    render(<EditUserDialog user={MECHANIC_USER} open={true} onOpenChange={onOpenChange} />, {
      wrapper: wrap,
    });

    // Step 1: click "Disattiva utente".
    await user.click(screen.getByTestId('deactivate-button'));

    // Step 2: click "Conferma disattivazione".
    await user.click(screen.getByTestId('deactivate-confirm-button'));

    await waitFor(() => {
      expect(mockDeleteMutateAsync).toHaveBeenCalledWith(MECHANIC_USER.id);
    });
    // Dialog closes on success.
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('Annulla after first confirm click cancels without calling useDeleteUser', async () => {
    const user = userEvent.setup();
    render(<EditUserDialog user={SUPER_ADMIN_USER} open={true} onOpenChange={() => {}} />, {
      wrapper: wrap,
    });

    // Step 1: open confirm.
    await user.click(screen.getByTestId('deactivate-button'));
    expect(screen.getByText(/sei sicuro/i)).toBeInTheDocument();

    // Step 2: click Annulla (the one inside the confirm row).
    const annullaButtons = screen.getAllByRole('button', { name: /annulla/i });
    // The confirm-section Annulla is the one visible in the deactivate section.
    await user.click(annullaButtons[annullaButtons.length - 1]);

    // Confirm step should be gone; original button back.
    await waitFor(() => {
      expect(screen.getByTestId('deactivate-button')).toBeInTheDocument();
    });
    expect(mockDeleteMutateAsync).not.toHaveBeenCalled();
  });

  // ── Successful role change closes dialog ───────────────────────────────────

  it('successful role save (no role change) closes the dialog', async () => {
    mockUpdateMutateAsync.mockResolvedValue({ user: SUPER_ADMIN_USER });
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<EditUserDialog user={SUPER_ADMIN_USER} open={true} onOpenChange={onOpenChange} />, {
      wrapper: wrap,
    });

    await user.click(screen.getByRole('button', { name: /salva ruolo/i }));

    await waitFor(() => {
      expect(mockUpdateMutateAsync).toHaveBeenCalledWith({
        id: SUPER_ADMIN_USER.id,
        body: { role: 'super_admin' },
      });
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  // ── BR-203 server error on deactivate ──────────────────────────────────────

  it('BR-203: 409 user.last_super_admin on deactivate surfaces deactivate-error banner', async () => {
    mockDeleteMutateAsync.mockRejectedValue(
      new ApiError('user.last_super_admin', 409, "Non puoi rimuovere l'ultimo amministratore."),
    );

    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<EditUserDialog user={SUPER_ADMIN_USER} open={true} onOpenChange={onOpenChange} />, {
      wrapper: wrap,
    });

    // Open confirm and confirm.
    await user.click(screen.getByTestId('deactivate-button'));
    await user.click(screen.getByTestId('deactivate-confirm-button'));

    await waitFor(() => {
      expect(screen.getByTestId('deactivate-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('deactivate-error')).toHaveTextContent(
      /Non puoi rimuovere l.+ultimo amministratore/i,
    );
    // Dialog must remain open.
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
