import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { LocationManagement } from './LocationManagement';

const update = vi.fn();
const del = vi.fn();
const locations = [
  {
    id: 'p1',
    name: 'Sede Milano',
    addressLine: 'Via Milano 1',
    city: 'Milano',
    province: 'MI',
    postalCode: '20100',
    country: 'IT',
    phone: null,
    email: null,
    isPrimary: true,
  },
  {
    id: 's2',
    name: 'Sede Roma',
    addressLine: 'Via Roma 2',
    city: 'Roma',
    province: 'RM',
    postalCode: '00100',
    country: 'IT',
    phone: null,
    email: null,
    isPrimary: false,
  },
];

vi.mock('@/queries/locations', async () => {
  const actual = await vi.importActual<object>('@/queries/locations');
  return {
    ...actual,
    useLocations: () => ({ isPending: false, isError: false, data: { locations } }),
    useUpdateLocation: () => ({ mutate: update, isPending: false }),
    useDeleteLocation: () => ({ mutate: del, isPending: false }),
  };
});

// LocationFormDialog is exercised in its own test; stub it here to keep this
// page test about the list + actions only.
vi.mock('@/components/locations/LocationFormDialog', () => ({
  LocationFormDialog: () => null,
}));

function renderPage() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <LocationManagement />
    </QueryClientProvider>,
  );
}

describe('LocationManagement', () => {
  beforeEach(() => {
    update.mockReset();
    del.mockReset();
  });

  it('lists locations with a Primaria badge and hides destructive actions on the primary', () => {
    renderPage();
    expect(screen.getByText('Sede Milano')).toBeInTheDocument();
    expect(screen.getByText('Primaria')).toBeInTheDocument();
    // Primary has no set-primary / deactivate; secondary does.
    expect(screen.queryByTestId('set-primary-p1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('deactivate-p1')).not.toBeInTheDocument();
    expect(screen.getByTestId('set-primary-s2')).toBeInTheDocument();
    expect(screen.getByTestId('deactivate-s2')).toBeInTheDocument();
  });

  it('promotes a secondary location to primary', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByTestId('set-primary-s2'));
    expect(update).toHaveBeenCalledWith({ id: 's2', body: { isPrimary: true } });
  });

  it('deactivates a secondary location after confirming', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByTestId('deactivate-s2'));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Disattiva' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('s2'));
  });
});
