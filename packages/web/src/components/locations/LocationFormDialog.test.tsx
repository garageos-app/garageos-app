import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { LocationFormDialog } from './LocationFormDialog';
import type { TenantLocation } from '@/queries/locations';

const create = vi.fn();
const update = vi.fn();
vi.mock('@/queries/locations', async () => {
  const actual = await vi.importActual<object>('@/queries/locations');
  return {
    ...actual,
    useCreateLocation: () => ({ mutateAsync: create, isPending: false }),
    useUpdateLocation: () => ({ mutateAsync: update, isPending: false }),
  };
});

function renderDialog(location: TenantLocation | null) {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <LocationFormDialog location={location} open onOpenChange={() => {}} />
    </QueryClientProvider>,
  );
}

describe('LocationFormDialog', () => {
  beforeEach(() => {
    create.mockReset().mockResolvedValue({ location: {} });
    update.mockReset().mockResolvedValue({ location: {} });
  });

  it('creates a location with uppercased province and IT country default', async () => {
    const user = userEvent.setup();
    renderDialog(null);

    await user.type(screen.getByLabelText('Nome *'), 'Sede Roma');
    await user.type(screen.getByLabelText('Indirizzo *'), 'Via Roma 1');
    await user.type(screen.getByLabelText('Città *'), 'Roma');
    await user.type(screen.getByLabelText('Provincia *'), 'rm');
    await user.type(screen.getByLabelText('CAP *'), '00100');
    await user.click(screen.getByRole('button', { name: 'Crea sede' }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ province: 'RM', country: 'IT', phone: null, email: null }),
    );
  });

  it('shows a validation error for a malformed CAP', async () => {
    const user = userEvent.setup();
    renderDialog(null);

    await user.type(screen.getByLabelText('Nome *'), 'X');
    await user.type(screen.getByLabelText('Indirizzo *'), 'Via 1');
    await user.type(screen.getByLabelText('Città *'), 'Roma');
    await user.type(screen.getByLabelText('Provincia *'), 'RM');
    await user.type(screen.getByLabelText('CAP *'), '123');
    await user.click(screen.getByRole('button', { name: 'Crea sede' }));

    expect(await screen.findByText('CAP: 5 cifre')).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });

  it('prefills fields in edit mode and PATCHes', async () => {
    const user = userEvent.setup();
    renderDialog({
      id: 'loc-1',
      name: 'Sede Milano',
      addressLine: 'Via Milano 1',
      city: 'Milano',
      province: 'MI',
      postalCode: '20100',
      country: 'IT',
      phone: null,
      email: null,
      isPrimary: false,
    });

    expect(screen.getByLabelText('Nome *')).toHaveValue('Sede Milano');
    await user.click(screen.getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'loc-1', body: expect.objectContaining({ city: 'Milano' }) }),
    );
  });
});
