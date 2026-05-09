import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { CustomerAutocomplete } from './CustomerAutocomplete';
import type { Customer, CustomerSearchResponse } from '@/queries/types';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  useApiFetch: () => apiFetchMock,
}));

function wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const customers: Customer[] = [
  {
    id: 'cust-mario',
    firstName: 'Mario',
    lastName: 'Rossi',
    email: 'mario.rossi@example.it',
    phone: null,
    isBusiness: false,
    businessName: null,
    vatNumber: null,
    status: 'active',
  },
  {
    id: 'cust-marina',
    firstName: 'Marina',
    lastName: 'Bianchi',
    email: 'marina@example.it',
    phone: null,
    isBusiness: false,
    businessName: null,
    vatNumber: null,
    status: 'active',
  },
  {
    id: 'cust-trattoria',
    firstName: 'Luigi',
    lastName: 'Trattoria',
    email: 'mario@trattoria.it',
    phone: null,
    isBusiness: true,
    businessName: 'Trattoria Da Luigi S.r.l.',
    vatNumber: 'IT01234567890',
    status: 'active',
  },
];

describe('CustomerAutocomplete', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the input and an initial hint when empty', () => {
    render(<CustomerAutocomplete onSelect={vi.fn()} />, { wrapper: wrap });
    expect(screen.getByRole('combobox')).toBeInTheDocument();
    expect(screen.queryByText(/nessun cliente/i)).not.toBeInTheDocument();
  });

  it('shows the min-2-char hint when typing 1 char', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<CustomerAutocomplete onSelect={vi.fn()} />, { wrapper: wrap });
    await user.type(screen.getByRole('combobox'), 'a');
    expect(screen.getByText(/almeno 2 caratteri/i)).toBeInTheDocument();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('debounces 250ms before firing the search', async () => {
    apiFetchMock.mockResolvedValue({
      data: customers,
      meta: { has_more: false },
    } satisfies CustomerSearchResponse);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<CustomerAutocomplete onSelect={vi.fn()} />, { wrapper: wrap });
    await user.type(screen.getByRole('combobox'), 'mar');
    expect(apiFetchMock).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(250);
    });
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(apiFetchMock).toHaveBeenCalledWith('/v1/customers/search?q=mar&limit=20');
  });

  it('renders B2C and B2B rows correctly with email and badge', async () => {
    apiFetchMock.mockResolvedValue({
      data: customers,
      meta: { has_more: false },
    } satisfies CustomerSearchResponse);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<CustomerAutocomplete onSelect={vi.fn()} />, { wrapper: wrap });
    await user.type(screen.getByRole('combobox'), 'mar');
    act(() => {
      vi.advanceTimersByTime(250);
    });

    await waitFor(() => expect(screen.getByText(/Mario Rossi/i)).toBeInTheDocument());
    expect(screen.getByText('mario.rossi@example.it')).toBeInTheDocument();
    expect(screen.getByText(/Trattoria Da Luigi/)).toBeInTheDocument();
    expect(screen.getByText('B2B')).toBeInTheDocument();
  });

  it('shows "Nessun cliente trovato" on empty result', async () => {
    apiFetchMock.mockResolvedValue({
      data: [],
      meta: { has_more: false },
    } satisfies CustomerSearchResponse);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<CustomerAutocomplete onSelect={vi.fn()} />, { wrapper: wrap });
    await user.type(screen.getByRole('combobox'), 'zz');
    act(() => {
      vi.advanceTimersByTime(250);
    });

    await waitFor(() => expect(screen.getByText(/nessun cliente trovato/i)).toBeInTheDocument());
  });

  it('shows an error fallback on query failure', async () => {
    apiFetchMock.mockRejectedValue(new Error('boom'));

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<CustomerAutocomplete onSelect={vi.fn()} />, { wrapper: wrap });
    await user.type(screen.getByRole('combobox'), 'mar');
    act(() => {
      vi.advanceTimersByTime(250);
    });

    await waitFor(() => expect(screen.getByText(/errore/i)).toBeInTheDocument());
  });

  it('invokes onSelect with the full customer when an item is clicked', async () => {
    apiFetchMock.mockResolvedValue({
      data: customers,
      meta: { has_more: false },
    } satisfies CustomerSearchResponse);

    const onSelect = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<CustomerAutocomplete onSelect={onSelect} />, { wrapper: wrap });
    await user.type(screen.getByRole('combobox'), 'mar');
    act(() => {
      vi.advanceTimersByTime(250);
    });

    await waitFor(() => expect(screen.getByText(/Marina Bianchi/i)).toBeInTheDocument());
    await user.click(screen.getByText(/Marina Bianchi/i));

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cust-marina', firstName: 'Marina' }),
    );
  });
});
