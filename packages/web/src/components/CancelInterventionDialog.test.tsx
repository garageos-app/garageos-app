import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { CancelInterventionDialog } from './CancelInterventionDialog';
import { ApiError } from '@/lib/api-client';

const { mockApiFetch, mockToastSuccess, mockToastError } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
}));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
  return {
    ...actual,
    useApiFetch: () => mockApiFetch,
  };
});

vi.mock('sonner', () => ({
  toast: { success: mockToastSuccess, error: mockToastError },
}));

function wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const INTERVENTION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('CancelInterventionDialog', () => {
  beforeEach(() => {
    mockApiFetch.mockClear();
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
  });

  // 1. Renders Dialog content when open=true
  it('renders dialog content when open is true', () => {
    render(
      <CancelInterventionDialog
        interventionId={INTERVENTION_ID}
        open={true}
        onOpenChange={() => {}}
      />,
      { wrapper: wrap },
    );
    expect(screen.getByRole('heading', { name: 'Annulla intervento' })).toBeInTheDocument();
    expect(screen.getByLabelText(/motivo dell'annullamento/i)).toBeInTheDocument();
    // Cancel (ghost) button
    expect(screen.getByRole('button', { name: /chiudi/i })).toBeInTheDocument();
    // Submit (destructive) button — use getAllByRole because title h2 + button share the same text
    expect(screen.getByRole('button', { name: /annulla intervento/i })).toBeInTheDocument();
  });

  // 2. Closed when open=false — Dialog content not in DOM
  it('does not render dialog content when open is false', () => {
    render(
      <CancelInterventionDialog
        interventionId={INTERVENTION_ID}
        open={false}
        onOpenChange={() => {}}
      />,
      { wrapper: wrap },
    );
    expect(screen.queryByText('Annulla intervento')).not.toBeInTheDocument();
  });

  // 3. Submit with <20 char reason shows inline error, no mutation called
  it('shows inline error when reason is shorter than 20 characters', async () => {
    const user = userEvent.setup();
    render(
      <CancelInterventionDialog
        interventionId={INTERVENTION_ID}
        open={true}
        onOpenChange={() => {}}
      />,
      { wrapper: wrap },
    );
    await user.type(screen.getByLabelText(/motivo dell'annullamento/i), '0123456789');
    await user.click(screen.getByRole('button', { name: /annulla intervento/i }));
    expect(await screen.findByText(/almeno 20 caratteri/i)).toBeInTheDocument();
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  // 4. Submit with valid reason calls mutation with { reason }
  it('calls mutation with reason payload when reason is valid', async () => {
    const user = userEvent.setup();
    mockApiFetch.mockResolvedValueOnce({ intervention: { id: INTERVENTION_ID } });
    const onOpenChange = vi.fn();
    render(
      <CancelInterventionDialog
        interventionId={INTERVENTION_ID}
        open={true}
        onOpenChange={onOpenChange}
      />,
      { wrapper: wrap },
    );
    const reasonText = 'Motivo valido lungo abbastanza';
    await user.type(screen.getByLabelText(/motivo dell'annullamento/i), reasonText);
    await user.click(screen.getByRole('button', { name: /annulla intervento/i }));
    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        `/v1/interventions/${INTERVENTION_ID}/cancel`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ reason: reasonText }),
        }),
      );
    });
  });

  // 5. Happy path: success → toast.success + onOpenChange(false)
  it('shows success toast and closes dialog on successful cancel', async () => {
    const user = userEvent.setup();
    mockApiFetch.mockResolvedValueOnce({ intervention: { id: INTERVENTION_ID } });
    const onOpenChange = vi.fn();
    render(
      <CancelInterventionDialog
        interventionId={INTERVENTION_ID}
        open={true}
        onOpenChange={onOpenChange}
      />,
      { wrapper: wrap },
    );
    await user.type(
      screen.getByLabelText(/motivo dell'annullamento/i),
      'Motivo valido lungo abbastanza',
    );
    await user.click(screen.getByRole('button', { name: /annulla intervento/i }));
    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalledWith('Intervento annullato.');
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  // 6. Error 403 intervention.cancellation.permission_denied → toast.error + close
  it('shows permission error toast and closes on 403 permission_denied', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    mockApiFetch.mockRejectedValueOnce(
      new ApiError(
        'intervention.cancellation.permission_denied',
        403,
        'Solo il super_admin del tenant può annullare un intervento.',
      ),
    );
    render(
      <CancelInterventionDialog
        interventionId={INTERVENTION_ID}
        open={true}
        onOpenChange={onOpenChange}
      />,
      { wrapper: wrap },
    );
    await user.type(
      screen.getByLabelText(/motivo dell'annullamento/i),
      'Motivo valido lungo abbastanza',
    );
    await user.click(screen.getByRole('button', { name: /annulla intervento/i }));
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        "Solo l'admin dell'officina può annullare un intervento.",
      );
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  // 7. Error 409 intervention.cancellation.already_cancelled → toast + close
  it('shows already cancelled toast and closes on 409 already_cancelled', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    mockApiFetch.mockRejectedValueOnce(
      new ApiError('intervention.cancellation.already_cancelled', 409, 'Intervento già annullato.'),
    );
    render(
      <CancelInterventionDialog
        interventionId={INTERVENTION_ID}
        open={true}
        onOpenChange={onOpenChange}
      />,
      { wrapper: wrap },
    );
    await user.type(
      screen.getByLabelText(/motivo dell'annullamento/i),
      'Motivo valido lungo abbastanza',
    );
    await user.click(screen.getByRole('button', { name: /annulla intervento/i }));
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Intervento già annullato.');
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  // 8. Error 5xx → toast + keep open (onOpenChange NOT called with false)
  it('shows server error toast and keeps dialog open on 5xx', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    mockApiFetch.mockRejectedValueOnce(
      new ApiError('INTERNAL_SERVER_ERROR', 500, 'An unexpected error occurred.'),
    );
    render(
      <CancelInterventionDialog
        interventionId={INTERVENTION_ID}
        open={true}
        onOpenChange={onOpenChange}
      />,
      { wrapper: wrap },
    );
    await user.type(
      screen.getByLabelText(/motivo dell'annullamento/i),
      'Motivo valido lungo abbastanza',
    );
    await user.click(screen.getByRole('button', { name: /annulla intervento/i }));
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        'Errore del server. Riprova tra qualche istante.',
      );
    });
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
