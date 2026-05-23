import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import { ScadenzeCard } from './ScadenzeCard';
import type { TenantDeadline } from '@/queries/types';

vi.mock('@/queries/deadlinesUpcoming', () => ({
  useDeadlinesUpcoming: vi.fn(),
}));

import { useDeadlinesUpcoming } from '@/queries/deadlinesUpcoming';

function makeDeadline(id: string, dueDate: string, plate: string): TenantDeadline {
  return {
    id,
    vehicleId: 'v-' + id,
    interventionTypeId: 't1',
    dueDate,
    dueOdometerKm: null,
    description: null,
    isRecurring: false,
    status: 'open',
    vehicle: {
      id: 'v-' + id,
      plate,
      make: 'Fiat',
      model: 'Panda',
      currentOwnership: null,
    },
    interventionType: { id: 't1', code: 'maint', nameIt: 'Tagliando' },
  };
}

function renderWithRouter(initialPath = '/') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/" element={<ScadenzeCard />} />
        <Route path="/vehicles/:id" element={<div data-testid="vehicle-page" />} />
        <Route path="/deadlines" element={<div data-testid="deadlines-page" />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('<ScadenzeCard />', () => {
  it('shows loading skeleton while pending', () => {
    (useDeadlinesUpcoming as ReturnType<typeof vi.fn>).mockReturnValue({
      isLoading: true,
      isError: false,
      data: undefined,
    });
    const { container } = renderWithRouter();
    expect(
      container.querySelectorAll('[data-testid="cardshell-loading-row"]').length,
    ).toBeGreaterThan(0);
  });

  it('shows empty state when no deadlines', () => {
    (useDeadlinesUpcoming as ReturnType<typeof vi.fn>).mockReturnValue({
      isLoading: false,
      isError: false,
      data: [],
    });
    renderWithRouter();
    expect(screen.getByText('Nessuna scadenza nei prossimi 7 giorni')).toBeInTheDocument();
  });

  it('shows error state on fetch error', () => {
    (useDeadlinesUpcoming as ReturnType<typeof vi.fn>).mockReturnValue({
      isLoading: false,
      isError: true,
      data: undefined,
    });
    renderWithRouter();
    expect(screen.getByText('Errore di caricamento — riprova')).toBeInTheDocument();
  });

  it('renders top 5 deadlines with plate + intervention type + IT date', () => {
    const deadlines = [
      makeDeadline('d1', '2026-05-25', 'AB123CD'),
      makeDeadline('d2', '2026-05-26', 'EF456GH'),
      makeDeadline('d3', '2026-05-27', 'IJ789KL'),
      makeDeadline('d4', '2026-05-28', 'MN012OP'),
      makeDeadline('d5', '2026-05-29', 'QR345ST'),
      makeDeadline('d6', '2026-05-30', 'UV678WX'),
    ];
    (useDeadlinesUpcoming as ReturnType<typeof vi.fn>).mockReturnValue({
      isLoading: false,
      isError: false,
      data: deadlines,
    });
    renderWithRouter();
    expect(screen.getByText('AB123CD')).toBeInTheDocument();
    expect(screen.getByText('QR345ST')).toBeInTheDocument();
    expect(screen.queryByText('UV678WX')).not.toBeInTheDocument(); // 6th excluded
    expect(screen.getAllByText('Tagliando').length).toBeGreaterThan(0);
    // Italian date format check: 25/05/2026
    expect(screen.getByText('25/05/2026')).toBeInTheDocument();
  });

  it('renders count badge equal to TOTAL upcoming (not just top 5)', () => {
    const deadlines = Array.from({ length: 7 }, (_, i) =>
      makeDeadline('d' + i, `2026-05-${25 + i}`, `PL${i}`),
    );
    (useDeadlinesUpcoming as ReturnType<typeof vi.fn>).mockReturnValue({
      isLoading: false,
      isError: false,
      data: deadlines,
    });
    renderWithRouter();
    expect(screen.getByText('7')).toBeInTheDocument();
  });

  it('navigates to /vehicles/:id on row click', async () => {
    const user = userEvent.setup();
    const deadlines = [makeDeadline('d1', '2026-05-25', 'AB123CD')];
    (useDeadlinesUpcoming as ReturnType<typeof vi.fn>).mockReturnValue({
      isLoading: false,
      isError: false,
      data: deadlines,
    });
    renderWithRouter();
    await user.click(screen.getByText('AB123CD'));
    expect(screen.getByTestId('vehicle-page')).toBeInTheDocument();
  });

  it('navigates to /deadlines on "Vedi tutte" link', async () => {
    const user = userEvent.setup();
    (useDeadlinesUpcoming as ReturnType<typeof vi.fn>).mockReturnValue({
      isLoading: false,
      isError: false,
      data: [makeDeadline('d1', '2026-05-25', 'AB123CD')],
    });
    renderWithRouter();
    await user.click(screen.getByRole('link', { name: /vedi tutte/i }));
    expect(screen.getByTestId('deadlines-page')).toBeInTheDocument();
  });

  it('does not show "Vedi tutte" link when no deadlines', () => {
    (useDeadlinesUpcoming as ReturnType<typeof vi.fn>).mockReturnValue({
      isLoading: false,
      isError: false,
      data: [],
    });
    renderWithRouter();
    expect(screen.queryByRole('link', { name: /vedi tutte/i })).not.toBeInTheDocument();
  });
});
