import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { DisputeResponseDialog } from './DisputeResponseDialog';
import type { InterventionDispute } from '@/queries/types';
import { ApiError } from '@/lib/api-client';

// Mock Radix Dialog so portal rendering works in JSDOM.
// See memory: feedback_jsdom_radix_select_mock_pattern.md
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}));

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
  return {
    ...actual,
    useApiFetch: () => apiFetchMock,
  };
});

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (msg: string) => toastSuccess(msg),
    error: (msg: string) => toastError(msg),
  },
}));

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }
  return { Wrapper, qc };
}

const openDispute: InterventionDispute = {
  id: 'd1',
  reasonCategory: 'not_performed',
  customerDescription: 'Lavoro non eseguito.',
  status: 'open',
  tenantResponse: null,
  tenantResponseAt: null,
  tenantResponseUser: null,
  createdAt: '2026-04-01T10:00:00.000Z',
  resolvedAt: null,
};

const respondedDispute: InterventionDispute = {
  ...openDispute,
  id: 'd2',
  customerDescription: 'Dati veicolo errati nel documento.',
  status: 'responded',
  tenantResponse: 'Risposta storica completa.',
  tenantResponseAt: '2026-04-15T10:30:00.000Z',
  tenantResponseUser: { firstName: 'Mario', lastName: 'Rossi' },
};

describe('DisputeResponseDialog', () => {
  it('does not render content when open=false', () => {
    apiFetchMock.mockClear();
    const { Wrapper } = makeWrapper();
    render(
      <Wrapper>
        <DisputeResponseDialog
          interventionId="int-1"
          vehicleId="veh-1"
          interventionTitle="Tagliando"
          open={false}
          onOpenChange={vi.fn()}
        />
      </Wrapper>,
    );
    expect(screen.queryByText(/Contestazioni/)).not.toBeInTheDocument();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('shows loading skeleton then renders open + responded sections', async () => {
    apiFetchMock.mockClear();
    apiFetchMock.mockImplementationOnce(
      () =>
        new Promise((r) => setTimeout(() => r({ disputes: [openDispute, respondedDispute] }), 10)),
    );
    const { Wrapper } = makeWrapper();
    render(
      <Wrapper>
        <DisputeResponseDialog
          interventionId="int-1"
          vehicleId="veh-1"
          interventionTitle="Tagliando 30000 km"
          open
          onOpenChange={vi.fn()}
        />
      </Wrapper>,
    );

    expect(screen.getByText(/Contestazioni · Tagliando 30000 km/)).toBeInTheDocument();
    expect(screen.getByTestId('disputes-loading')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByText('Da rispondere')).toBeInTheDocument());
    expect(screen.getByText('Già risposte')).toBeInTheDocument();
    expect(screen.getByText('Lavoro non eseguito.')).toBeInTheDocument();
    expect(screen.getByText('Dati veicolo errati nel documento.')).toBeInTheDocument();
    expect(screen.getByText('Risposta storica completa.')).toBeInTheDocument();
  });

  it('renders empty state when no disputes returned', async () => {
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValueOnce({ disputes: [] });
    const { Wrapper } = makeWrapper();
    render(
      <Wrapper>
        <DisputeResponseDialog
          interventionId="int-1"
          vehicleId="veh-1"
          interventionTitle="Tagliando"
          open
          onOpenChange={vi.fn()}
        />
      </Wrapper>,
    );
    await waitFor(() =>
      expect(screen.getByText('Nessuna contestazione su questo intervento.')).toBeInTheDocument(),
    );
  });

  it('submits the response, shows success toast, and refetches', async () => {
    apiFetchMock.mockClear();
    toastSuccess.mockClear();
    // First call: GET disputes (1 open)
    apiFetchMock.mockResolvedValueOnce({ disputes: [openDispute] });
    // Second call: POST response — returns updated dispute + active intervention status
    apiFetchMock.mockResolvedValueOnce({
      disputes: [{ ...openDispute, status: 'responded' }],
      interventionStatus: 'active',
    });
    // Third call: GET disputes refetch (invalidation triggered by useRespondToDispute onSuccess)
    apiFetchMock.mockResolvedValueOnce({
      disputes: [
        {
          ...openDispute,
          status: 'responded',
          tenantResponse: 'OK',
          tenantResponseAt: '2026-05-10T10:00:00.000Z',
          tenantResponseUser: { firstName: 'M', lastName: 'R' },
        },
      ],
    });

    const user = userEvent.setup();
    const { Wrapper } = makeWrapper();
    render(
      <Wrapper>
        <DisputeResponseDialog
          interventionId="int-1"
          vehicleId="veh-1"
          interventionTitle="Tagliando"
          open
          onOpenChange={vi.fn()}
        />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByText('Da rispondere')).toBeInTheDocument());
    await user.type(
      screen.getByLabelText(/Risposta dell.officina/),
      'Risposta tecnica articolata di almeno venti caratteri.',
    );
    await user.click(screen.getByRole('button', { name: 'Invia risposta' }));

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        'Risposta inviata. La contestazione è stata chiusa.',
      ),
    );
  });

  it('maps 409 no_active_dispute to Italian error toast', async () => {
    apiFetchMock.mockClear();
    toastError.mockClear();
    apiFetchMock.mockResolvedValueOnce({ disputes: [openDispute] });
    apiFetchMock.mockRejectedValueOnce(
      new ApiError('intervention.dispute.response.no_active_dispute', 409, 'Non aperta'),
    );
    apiFetchMock.mockResolvedValueOnce({ disputes: [] }); // refetch after mapping

    const user = userEvent.setup();
    const { Wrapper } = makeWrapper();
    render(
      <Wrapper>
        <DisputeResponseDialog
          interventionId="int-1"
          vehicleId="veh-1"
          interventionTitle="Tagliando"
          open
          onOpenChange={vi.fn()}
        />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByText('Da rispondere')).toBeInTheDocument());
    await user.type(
      screen.getByLabelText(/Risposta dell.officina/),
      'Una risposta abbastanza lunga per passare la validazione.',
    );
    await user.click(screen.getByRole('button', { name: 'Invia risposta' }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'La contestazione non è più aperta. Aggiorno la pagina.',
      ),
    );
  });

  it('closes dialog when GET returns intervention.not_found', async () => {
    apiFetchMock.mockClear();
    toastError.mockClear();
    apiFetchMock.mockRejectedValueOnce(
      new ApiError('intervention.not_found', 404, 'Intervento non trovato'),
    );

    const onOpenChange = vi.fn();
    const { Wrapper } = makeWrapper();
    render(
      <Wrapper>
        <DisputeResponseDialog
          interventionId="int-1"
          vehicleId="veh-1"
          interventionTitle="Tagliando"
          open
          onOpenChange={onOpenChange}
        />
      </Wrapper>,
    );

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Intervento non più disponibile.'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
