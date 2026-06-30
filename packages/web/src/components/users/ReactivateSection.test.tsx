// ReactivateSection tests — F-OFF-004 reactivation slice (BR-212).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { ReactivateSection } from './ReactivateSection';
import type { AdminUser } from '@/queries/users-admin';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mutateAsyncMock = vi.fn();
const mutationState = {
  mutateAsync: mutateAsyncMock,
  isPending: false,
  isError: false,
  error: null as { code: string; message: string } | null,
};

vi.mock('@/queries/users-admin', async () => {
  const actual =
    await vi.importActual<typeof import('@/queries/users-admin')>('@/queries/users-admin');
  return {
    ...actual,
    useReactivateUser: () => mutationState,
  };
});

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function wrapWithQC(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const INACTIVE_MECH: AdminUser = {
  id: 'u-1',
  email: 'mech@x.test',
  firstName: 'Mario',
  lastName: 'Rossi',
  role: 'mechanic',
  status: 'inactive',
  createdAt: '2026-01-01T00:00:00Z',
  deletedAt: '2026-05-01T00:00:00Z',
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ReactivateSection', () => {
  beforeEach(() => {
    mutateAsyncMock.mockReset();
    mutationState.isPending = false;
    mutationState.isError = false;
    mutationState.error = null;
  });

  it('renders primary button + preview email/role', () => {
    wrapWithQC(<ReactivateSection user={INACTIVE_MECH} onSuccess={() => {}} />);
    expect(screen.getByTestId('reactivate-section')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^riattiva utente$/i })).toBeInTheDocument();
    expect(screen.getByText(/mech@x\.test/)).toBeInTheDocument();
  });

  it('click primary → mostra step conferma', async () => {
    const user = userEvent.setup();
    wrapWithQC(<ReactivateSection user={INACTIVE_MECH} onSuccess={() => {}} />);
    await user.click(screen.getByRole('button', { name: /^riattiva utente$/i }));
    expect(screen.getByRole('button', { name: /^conferma riattivazione$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^annulla$/i })).toBeInTheDocument();
  });

  it('click conferma → calls mutateAsync con body vuoto + onSuccess', async () => {
    mutateAsyncMock.mockResolvedValue({
      user: { ...INACTIVE_MECH, status: 'active', deletedAt: null },
    });
    const onSuccess = vi.fn();
    const user = userEvent.setup();
    wrapWithQC(<ReactivateSection user={INACTIVE_MECH} onSuccess={onSuccess} />);
    await user.click(screen.getByRole('button', { name: /^riattiva utente$/i }));
    await user.click(screen.getByRole('button', { name: /^conferma riattivazione$/i }));

    expect(mutateAsyncMock).toHaveBeenCalledWith({ id: 'u-1', body: {} });
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
  });

  it('mutation error → mostra inline error', async () => {
    mutateAsyncMock.mockRejectedValue({
      name: 'ApiError',
      code: 'user.location_invalid',
      status: 422,
      message: 'Errore durante la riattivazione.',
    });
    const user = userEvent.setup();
    wrapWithQC(<ReactivateSection user={INACTIVE_MECH} onSuccess={() => {}} />);
    await user.click(screen.getByRole('button', { name: /^riattiva utente$/i }));
    await user.click(screen.getByRole('button', { name: /^conferma riattivazione$/i }));
    await waitFor(() =>
      expect(screen.getByTestId('reactivate-error')).toHaveTextContent(/errore durante/i),
    );
  });

  it('annulla riporta a step 1', async () => {
    const user = userEvent.setup();
    wrapWithQC(<ReactivateSection user={INACTIVE_MECH} onSuccess={() => {}} />);
    await user.click(screen.getByRole('button', { name: /^riattiva utente$/i }));
    await user.click(screen.getByRole('button', { name: /^annulla$/i }));
    expect(screen.getByRole('button', { name: /^riattiva utente$/i })).toBeInTheDocument();
  });
});
