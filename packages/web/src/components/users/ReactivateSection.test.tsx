// ReactivateSection tests — F-OFF-004 reactivation slice (BR-211).
//
// Per memory feedback_radix_tabs_user_event_not_fire_event: Radix Select
// portals do not open in JSDOM via fireEvent — use userEvent.click().

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { ReactivateSection } from './ReactivateSection';
import type { AdminUser, TenantLocation } from '@/queries/users-admin';

// JSDOM does not implement pointer capture APIs nor scrollIntoView, which
// Radix Select relies on. Polyfill no-ops so userEvent.click can drive the
// Select trigger without unhandled errors.
beforeAll(() => {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

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

const LOC_ACTIVE: TenantLocation = {
  id: 'loc-1',
  name: 'Sede Roma Centro',
  city: 'Roma',
  isPrimary: true,
};

const LOC_2: TenantLocation = {
  id: 'loc-2',
  name: 'Sede Roma Nord',
  city: 'Roma',
  isPrimary: false,
};

const INACTIVE_MECH: AdminUser = {
  id: 'u-1',
  email: 'mech@x.test',
  firstName: 'Mario',
  lastName: 'Rossi',
  role: 'mechanic',
  locationId: 'loc-1',
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

  it('renders primary button + preview email/role/sede', () => {
    wrapWithQC(
      <ReactivateSection
        user={INACTIVE_MECH}
        locations={[LOC_ACTIVE, LOC_2]}
        onSuccess={() => {}}
      />,
    );
    expect(screen.getByTestId('reactivate-section')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^riattiva utente$/i })).toBeInTheDocument();
    expect(screen.getByText(/mech@x\.test/)).toBeInTheDocument();
    expect(screen.getByText(/sede roma centro/i)).toBeInTheDocument();
  });

  it('click primary → mostra step conferma', async () => {
    const user = userEvent.setup();
    wrapWithQC(
      <ReactivateSection
        user={INACTIVE_MECH}
        locations={[LOC_ACTIVE, LOC_2]}
        onSuccess={() => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: /^riattiva utente$/i }));
    expect(screen.getByRole('button', { name: /^conferma riattivazione$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^annulla$/i })).toBeInTheDocument();
  });

  it('location stale (mechanic + user.locationId NOT in locations list) → mostra Select per nuova sede', async () => {
    const user = userEvent.setup();
    wrapWithQC(
      <ReactivateSection
        user={INACTIVE_MECH}
        locations={[LOC_2]} // loc-1 absent → stale
        onSuccess={() => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: /^riattiva utente$/i }));
    expect(screen.getByText(/sede non valida/i)).toBeInTheDocument();
    expect(screen.getByTestId('reactivate-location-select')).toBeInTheDocument();
    // Confirm button disabled until select.
    expect(screen.getByRole('button', { name: /^conferma riattivazione$/i })).toBeDisabled();
  });

  it('click conferma con location valida → calls mutateAsync con body vuoto + onSuccess', async () => {
    mutateAsyncMock.mockResolvedValue({
      user: { ...INACTIVE_MECH, status: 'active', deletedAt: null },
    });
    const onSuccess = vi.fn();
    const user = userEvent.setup();
    wrapWithQC(
      <ReactivateSection
        user={INACTIVE_MECH}
        locations={[LOC_ACTIVE, LOC_2]}
        onSuccess={onSuccess}
      />,
    );
    await user.click(screen.getByRole('button', { name: /^riattiva utente$/i }));
    await user.click(screen.getByRole('button', { name: /^conferma riattivazione$/i }));

    expect(mutateAsyncMock).toHaveBeenCalledWith({ id: 'u-1', body: {} });
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
  });

  it('mutation error user.location_invalid → mostra inline error', async () => {
    mutateAsyncMock.mockRejectedValue({
      name: 'ApiError',
      code: 'user.location_invalid',
      status: 422,
      message: 'Sede non valida o inattiva.',
    });
    const user = userEvent.setup();
    wrapWithQC(
      <ReactivateSection
        user={INACTIVE_MECH}
        locations={[LOC_ACTIVE, LOC_2]}
        onSuccess={() => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: /^riattiva utente$/i }));
    await user.click(screen.getByRole('button', { name: /^conferma riattivazione$/i }));
    await waitFor(() =>
      expect(screen.getByTestId('reactivate-error')).toHaveTextContent(/sede non valida/i),
    );
  });

  it('annulla riporta a step 1', async () => {
    const user = userEvent.setup();
    wrapWithQC(
      <ReactivateSection
        user={INACTIVE_MECH}
        locations={[LOC_ACTIVE, LOC_2]}
        onSuccess={() => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: /^riattiva utente$/i }));
    await user.click(screen.getByRole('button', { name: /^annulla$/i }));
    expect(screen.getByRole('button', { name: /^riattiva utente$/i })).toBeInTheDocument();
  });

  it('location stale + select nuova sede via dropdown → confirm abilitato + payload include locationId', async () => {
    mutateAsyncMock.mockResolvedValue({
      user: { ...INACTIVE_MECH, status: 'active', deletedAt: null, locationId: 'loc-2' },
    });
    const user = userEvent.setup();
    wrapWithQC(
      <ReactivateSection
        user={INACTIVE_MECH}
        locations={[LOC_2]} // stale: original loc-1 absent
        onSuccess={() => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: /^riattiva utente$/i }));
    // Use userEvent.click on Radix Select trigger (see feedback_radix_tabs_user_event_not_fire_event).
    await user.click(screen.getByTestId('reactivate-location-select'));
    await user.click(screen.getByRole('option', { name: /sede roma nord/i }));
    await user.click(screen.getByRole('button', { name: /^conferma riattivazione$/i }));
    expect(mutateAsyncMock).toHaveBeenCalledWith({ id: 'u-1', body: { locationId: 'loc-2' } });
  });
});
