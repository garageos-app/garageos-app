import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { CreateCustomerDialog } from './CreateCustomerDialog';

const { mockMutateAsync, mockToastSuccess, mockNavigate } = vi.hoisted(() => ({
  mockMutateAsync: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockNavigate: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { success: mockToastSuccess, error: vi.fn() } }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});
vi.mock('@/queries/customersCreate', () => ({
  useCreateCustomer: () => ({ mutateAsync: mockMutateAsync, isPending: false }),
}));

function wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function renderOpen() {
  return render(<CreateCustomerDialog open onOpenChange={vi.fn()} />, { wrapper: wrap });
}

describe('CreateCustomerDialog', () => {
  beforeEach(() => {
    mockMutateAsync.mockReset();
    mockToastSuccess.mockReset();
    mockNavigate.mockReset();
  });

  it('shows required-field errors and does not submit an empty form', async () => {
    renderOpen();
    await userEvent.click(screen.getByRole('button', { name: /crea cliente/i }));
    expect(await screen.findByText('Nome obbligatorio')).toBeInTheDocument();
    expect(screen.getByText('Cognome obbligatorio')).toBeInTheDocument();
    expect(screen.getByText('Email obbligatoria')).toBeInTheDocument();
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it('submits a valid form, navigates to the detail and toasts on created', async () => {
    mockMutateAsync.mockResolvedValueOnce({ id: 'c1', created: true });
    renderOpen();
    await userEvent.type(screen.getByLabelText('Nome'), 'Mario');
    await userEvent.type(screen.getByLabelText('Cognome'), 'Rossi');
    await userEvent.type(screen.getByLabelText('Email'), 'mario@example.it');
    await userEvent.click(screen.getByRole('button', { name: /crea cliente/i }));

    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        firstName: 'Mario',
        lastName: 'Rossi',
        email: 'mario@example.it',
        isBusiness: false,
      }),
    );
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/customers/c1'));
    expect(mockToastSuccess).toHaveBeenCalledWith('Cliente creato');
  });

  it('toasts the linked message when the customer already existed', async () => {
    mockMutateAsync.mockResolvedValueOnce({ id: 'c2', created: false });
    renderOpen();
    await userEvent.type(screen.getByLabelText('Nome'), 'Anna');
    await userEvent.type(screen.getByLabelText('Cognome'), 'Verdi');
    await userEvent.type(screen.getByLabelText('Email'), 'anna@example.it');
    await userEvent.click(screen.getByRole('button', { name: /crea cliente/i }));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/customers/c2'));
    expect(mockToastSuccess).toHaveBeenCalledWith(
      'Cliente già esistente, collegato alla tua officina',
    );
  });

  it('requires a business name when "Cliente aziendale" is on', async () => {
    renderOpen();
    await userEvent.type(screen.getByLabelText('Nome'), 'Ditta');
    await userEvent.type(screen.getByLabelText('Cognome'), 'Owner');
    await userEvent.type(screen.getByLabelText('Email'), 'ditta@example.it');
    await userEvent.click(screen.getByRole('switch', { name: /cliente aziendale/i }));
    await userEvent.click(screen.getByRole('button', { name: /crea cliente/i }));
    expect(await screen.findByText('Ragione sociale obbligatoria')).toBeInTheDocument();
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });
});
