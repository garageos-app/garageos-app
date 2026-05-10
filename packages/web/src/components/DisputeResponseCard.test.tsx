import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DisputeResponseCard } from './DisputeResponseCard';
import type { InterventionDispute } from '@/queries/types';

const openDispute: InterventionDispute = {
  id: 'd1',
  reasonCategory: 'not_performed',
  customerDescription: 'Lavoro non eseguito secondo accordi.',
  status: 'open',
  tenantResponse: null,
  tenantResponseAt: null,
  tenantResponseUser: null,
  createdAt: '2026-04-01T10:00:00.000Z',
  resolvedAt: null,
};

describe('DisputeResponseCard', () => {
  it('renders reason badge, customer description, form with empty textarea and 0/2000 counter', () => {
    render(<DisputeResponseCard dispute={openDispute} onSubmit={vi.fn()} />);
    expect(screen.getByText('Lavoro non svolto')).toBeInTheDocument();
    expect(screen.getByText('Lavoro non eseguito secondo accordi.')).toBeInTheDocument();
    expect(screen.getByLabelText(/Risposta dell.officina/)).toHaveValue('');
    expect(screen.getByText('0 / 2000')).toBeInTheDocument();
  });

  it('disables submit until 20+ chars are typed', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<DisputeResponseCard dispute={openDispute} onSubmit={onSubmit} />);

    const submit = screen.getByRole('button', { name: 'Invia risposta' });
    expect(submit).toBeDisabled();

    const textarea = screen.getByLabelText(/Risposta dell.officina/);
    await user.type(textarea, 'troppo corta');
    expect(submit).toBeDisabled();

    await user.type(textarea, ' aggiungo qualcosa per arrivare oltre venti.');
    await waitFor(() => expect(submit).toBeEnabled());
  });

  it('calls onSubmit with the typed value and resets the form on success', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<DisputeResponseCard dispute={openDispute} onSubmit={onSubmit} />);

    const textarea = screen.getByLabelText(/Risposta dell.officina/);
    await user.type(textarea, 'Risposta tecnica articolata di almeno venti caratteri.');
    await user.click(screen.getByRole('button', { name: 'Invia risposta' }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        'Risposta tecnica articolata di almeno venti caratteri.',
      ),
    );
    await waitFor(() => expect(textarea).toHaveValue(''));
  });

  it('keeps the form values when onSubmit throws', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockRejectedValue(new Error('Server error'));
    render(<DisputeResponseCard dispute={openDispute} onSubmit={onSubmit} />);

    const text = 'Una risposta abbastanza lunga da passare la validazione.';
    const textarea = screen.getByLabelText(/Risposta dell.officina/);
    await user.type(textarea, text);
    await user.click(screen.getByRole('button', { name: 'Invia risposta' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(textarea).toHaveValue(text);
  });

  it('shows "Invio in corso..." while pending', async () => {
    const user = userEvent.setup();
    let resolve: (() => void) | undefined;
    const onSubmit = vi.fn().mockImplementation(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    render(<DisputeResponseCard dispute={openDispute} onSubmit={onSubmit} />);

    await user.type(
      screen.getByLabelText(/Risposta dell.officina/),
      'Risposta abbastanza lunga per passare la validazione.',
    );
    await user.click(screen.getByRole('button', { name: 'Invia risposta' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Invio in corso...' })).toBeDisabled(),
    );
    await act(async () => {
      resolve?.();
    });
  });
});
