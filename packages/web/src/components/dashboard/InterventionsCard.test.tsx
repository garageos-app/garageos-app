import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import { InterventionsCard } from './InterventionsCard';
import type { RecentIntervention } from '@/queries/interventionsRecent';

vi.mock('@/queries/interventionsRecent', () => ({
  useInterventionsRecent: vi.fn(),
}));

import { useInterventionsRecent } from '@/queries/interventionsRecent';

function makeItem(
  id: string,
  createdAt: string,
  plate: string,
  summary: string,
  operatorName = 'Giuseppe Rossi',
): RecentIntervention {
  return {
    id,
    createdAt,
    status: 'active',
    summary,
    vehicle: {
      id: 'v-' + id,
      plate,
      make: 'Fiat',
      model: 'Panda',
    },
    operator: {
      id: 'u-' + id,
      name: operatorName,
    },
  };
}

function renderWithRouter() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<InterventionsCard />} />
        <Route path="/interventions/:id" element={<div data-testid="intervention-page" />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('<InterventionsCard />', () => {
  it('shows loading skeleton while pending', () => {
    (useInterventionsRecent as ReturnType<typeof vi.fn>).mockReturnValue({
      isLoading: true,
      isError: false,
      data: undefined,
    });
    const { container } = renderWithRouter();
    expect(
      container.querySelectorAll('[data-testid="cardshell-loading-row"]').length,
    ).toBeGreaterThan(0);
  });

  it('shows empty state when no interventions', () => {
    (useInterventionsRecent as ReturnType<typeof vi.fn>).mockReturnValue({
      isLoading: false,
      isError: false,
      data: [],
    });
    renderWithRouter();
    expect(screen.getByText('Nessun intervento ancora registrato')).toBeInTheDocument();
  });

  it('shows error state on fetch error', () => {
    (useInterventionsRecent as ReturnType<typeof vi.fn>).mockReturnValue({
      isLoading: false,
      isError: true,
      data: undefined,
    });
    renderWithRouter();
    expect(screen.getByText('Errore di caricamento — riprova')).toBeInTheDocument();
  });

  it('renders all items with plate, summary, operator name, and IT date', () => {
    const items = [
      makeItem('i1', '2026-05-23T10:00:00.000Z', 'AB123CD', 'Tagliando 60.000 km'),
      makeItem('i2', '2026-05-22T09:00:00.000Z', 'EF456GH', 'Cambio olio', 'Marco Bianchi'),
    ];
    (useInterventionsRecent as ReturnType<typeof vi.fn>).mockReturnValue({
      isLoading: false,
      isError: false,
      data: items,
    });
    renderWithRouter();
    expect(screen.getByText('AB123CD')).toBeInTheDocument();
    expect(screen.getByText('EF456GH')).toBeInTheDocument();
    expect(screen.getByText('Tagliando 60.000 km')).toBeInTheDocument();
    expect(screen.getByText('Cambio olio')).toBeInTheDocument();
    expect(screen.getByText(/Giuseppe Rossi/)).toBeInTheDocument();
    expect(screen.getByText(/Marco Bianchi/)).toBeInTheDocument();
    // Italian date format check
    expect(screen.getByText('23/05/2026')).toBeInTheDocument();
    expect(screen.getByText('22/05/2026')).toBeInTheDocument();
  });

  it('renders count badge equal to items length', () => {
    const items = Array.from({ length: 4 }, (_, i) =>
      makeItem(`i${i}`, '2026-05-23T10:00:00.000Z', `PL${i}`, `Lavoro ${i}`),
    );
    (useInterventionsRecent as ReturnType<typeof vi.fn>).mockReturnValue({
      isLoading: false,
      isError: false,
      data: items,
    });
    renderWithRouter();
    expect(screen.getByText('4')).toBeInTheDocument();
  });

  it('navigates to /interventions/:id on row click', async () => {
    const user = userEvent.setup();
    const items = [makeItem('i1', '2026-05-23T10:00:00.000Z', 'AB123CD', 'Lavoro X')];
    (useInterventionsRecent as ReturnType<typeof vi.fn>).mockReturnValue({
      isLoading: false,
      isError: false,
      data: items,
    });
    renderWithRouter();
    await user.click(screen.getByText('AB123CD'));
    expect(screen.getByTestId('intervention-page')).toBeInTheDocument();
  });

  it('renders BR-213 fallback "Operatore" when server returned it', () => {
    const items = [makeItem('i1', '2026-05-23T10:00:00.000Z', 'AB123CD', 'Lavoro X', 'Operatore')];
    (useInterventionsRecent as ReturnType<typeof vi.fn>).mockReturnValue({
      isLoading: false,
      isError: false,
      data: items,
    });
    renderWithRouter();
    expect(screen.getByText(/Operatore/)).toBeInTheDocument();
  });
});
