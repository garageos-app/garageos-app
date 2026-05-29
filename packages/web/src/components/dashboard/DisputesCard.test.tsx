import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DisputesCard } from './DisputesCard';
import { useDisputesOpen } from '@/queries/disputesOpen';

vi.mock('@/queries/disputesOpen');

const mockedUseDisputesOpen = vi.mocked(useDisputesOpen);

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<DisputesCard />} />
          <Route path="/interventions/:id" element={<div data-testid="intervention-detail" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.resetAllMocks();
});

describe('<DisputesCard />', () => {
  it('renders loading state initially', () => {
    mockedUseDisputesOpen.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    } as never);
    renderCard();
    expect(screen.getAllByTestId('cardshell-loading-row').length).toBeGreaterThan(0);
  });

  it('renders error state when query fails', () => {
    mockedUseDisputesOpen.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    } as never);
    renderCard();
    expect(screen.getByText('Errore di caricamento — riprova')).toBeInTheDocument();
  });

  it('renders empty state when both groups are empty', () => {
    mockedUseDisputesOpen.mockReturnValue({
      data: {
        pendingResponse: { count: 0, items: [] },
        inProgress: { count: 0, items: [] },
      },
      isLoading: false,
      isError: false,
    } as never);
    renderCard();
    expect(screen.getByText('Nessuna contestazione aperta')).toBeInTheDocument();
  });

  it('renders pending dispute row by default with destructive badge', () => {
    mockedUseDisputesOpen.mockReturnValue({
      data: {
        pendingResponse: {
          count: 1,
          items: [
            {
              id: 'd1',
              interventionId: 'i1',
              vehicleTarga: 'AB123CD',
              customerName: 'Mario Rossi',
              createdAt: '2026-05-22T09:15:00Z',
              reasonCategory: 'not_performed',
            },
          ],
        },
        inProgress: { count: 0, items: [] },
      },
      isLoading: false,
      isError: false,
    } as never);
    renderCard();
    expect(screen.getByText('AB123CD')).toBeInTheDocument();
    expect(screen.getByText('Mario Rossi')).toBeInTheDocument();
    expect(screen.getByText('Lavoro non eseguito')).toBeInTheDocument();
    const badge = screen.getByTestId('cardshell-count-badge');
    expect(badge).toHaveTextContent('1');
    expect(badge.className).toMatch(/destructive/);
    expect(screen.getByRole('tab', { name: /Da rispondere \(1\)/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /In corso \(0\)/i })).toBeInTheDocument();
  });

  it('switches to inProgress tab on userEvent.click (Radix Tabs)', async () => {
    const user = userEvent.setup();
    mockedUseDisputesOpen.mockReturnValue({
      data: {
        pendingResponse: { count: 0, items: [] },
        inProgress: {
          count: 1,
          items: [
            {
              id: 'd2',
              interventionId: 'i2',
              vehicleTarga: 'XY999ZZ',
              customerName: 'Lucia Bianchi',
              createdAt: '2026-05-20T11:00:00Z',
              status: 'responded',
              reasonCategory: 'wrong_data',
            },
          ],
        },
      },
      isLoading: false,
      isError: false,
    } as never);
    renderCard();
    expect(screen.queryByText('XY999ZZ')).not.toBeInTheDocument();
    const inProgressTab = screen.getByRole('tab', { name: /In corso \(1\)/i });
    await user.click(inProgressTab);
    expect(screen.getByText('XY999ZZ')).toBeInTheDocument();
    expect(screen.getByText('Lucia Bianchi')).toBeInTheDocument();
    expect(screen.getByText('Dati errati')).toBeInTheDocument();
  });

  it('navigates to /interventions/:id on row click', async () => {
    const user = userEvent.setup();
    mockedUseDisputesOpen.mockReturnValue({
      data: {
        pendingResponse: {
          count: 1,
          items: [
            {
              id: 'd3',
              interventionId: 'i-target',
              vehicleTarga: 'AB123CD',
              customerName: 'Mario Rossi',
              createdAt: '2026-05-22T09:15:00Z',
              reasonCategory: 'not_performed',
            },
          ],
        },
        inProgress: { count: 0, items: [] },
      },
      isLoading: false,
      isError: false,
    } as never);
    renderCard();
    await user.click(screen.getByText('AB123CD').closest('button')!);
    expect(screen.getByTestId('intervention-detail')).toBeInTheDocument();
  });

  it('hides destructive badge when pendingCount = 0 but inProgress has items', () => {
    mockedUseDisputesOpen.mockReturnValue({
      data: {
        pendingResponse: { count: 0, items: [] },
        inProgress: {
          count: 1,
          items: [
            {
              id: 'd4',
              interventionId: 'i4',
              vehicleTarga: 'TT111UU',
              customerName: 'Carla Verdi',
              createdAt: '2026-05-19T08:00:00Z',
              status: 'escalated',
              reasonCategory: 'other',
            },
          ],
        },
      },
      isLoading: false,
      isError: false,
    } as never);
    renderCard();
    expect(screen.queryByTestId('cardshell-count-badge')).not.toBeInTheDocument();
  });

  it('renders pending tab empty placeholder when pendingItems is empty but inProgress has data', () => {
    mockedUseDisputesOpen.mockReturnValue({
      data: {
        pendingResponse: { count: 0, items: [] },
        inProgress: {
          count: 1,
          items: [
            {
              id: 'd5',
              interventionId: 'i5',
              vehicleTarga: 'PP444QQ',
              customerName: 'Anna Neri',
              createdAt: '2026-05-18T12:00:00Z',
              status: 'escalated',
              reasonCategory: 'other',
            },
          ],
        },
      },
      isLoading: false,
      isError: false,
    } as never);
    renderCard();
    // Pending tab is the default selected one and must show the inner
    // empty-text. The CardShell empty STATE branch is NOT triggered here
    // because total count > 0; the placeholder comes from TabsContent.
    // Asserting the tab is visible proves CardShell state === 'data'
    // (Tabs render only inside CardShell's children slot), distinguishing
    // this branch from CardShell's own emptyText path.
    expect(screen.getByRole('tab', { name: /Da rispondere \(0\)/i })).toBeInTheDocument();
    expect(screen.getByText('Nessuna contestazione aperta')).toBeInTheDocument();
    // Sanity: inProgress data is not visible until the user switches tab.
    expect(screen.queryByText('PP444QQ')).not.toBeInTheDocument();
  });
});
