import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { InterventionsTable, STATUS_LABEL } from './InterventionsTable';
import type { InterventionListItem } from '@/queries/interventionsList';

const ITEMS: InterventionListItem[] = [
  {
    id: 'i-1',
    interventionDate: '2026-07-01',
    odometerKm: 12000,
    status: 'active',
    type: { id: 't1', nameIt: 'Intervento Meccanico' },
    vehicle: { id: 'v-1', plate: 'AB123CD', make: 'Fiat', model: 'Panda' },
    operator: { id: 'u-1', name: 'Mario Rossi' },
  },
  {
    id: 'i-2',
    interventionDate: '2026-06-15',
    odometerKm: 30000,
    status: 'disputed',
    type: { id: 't2', nameIt: 'Cambio Gomme' },
    vehicle: { id: 'v-2', plate: 'ZZ999YY', make: 'Audi', model: 'A3' },
    operator: { id: 'u-2', name: 'Luca Bianchi' },
  },
];

function renderTable(props: Partial<React.ComponentProps<typeof InterventionsTable>> = {}) {
  const onSortChange = vi.fn();
  render(
    <MemoryRouter>
      <InterventionsTable
        items={ITEMS}
        sort="date"
        order="desc"
        onSortChange={onSortChange}
        {...props}
      />
    </MemoryRouter>,
  );
  return onSortChange;
}

describe('InterventionsTable', () => {
  it('renders a row per item with plate, type, operator and status', () => {
    renderTable();
    expect(screen.getByText('AB123CD')).toBeInTheDocument();
    expect(screen.getByText('ZZ999YY')).toBeInTheDocument();
    expect(screen.getByText('Intervento Meccanico')).toBeInTheDocument();
    expect(screen.getByText('Mario Rossi')).toBeInTheDocument();
    expect(screen.getByText(STATUS_LABEL.active)).toBeInTheDocument();
    expect(screen.getByText(STATUS_LABEL.disputed)).toBeInTheDocument();
  });

  it('calls onSortChange when a sortable header is clicked', async () => {
    const onSortChange = renderTable();
    await userEvent.click(screen.getByRole('button', { name: /km/i }));
    expect(onSortChange).toHaveBeenCalledWith('km');
  });

  it('marks the active sort column with a direction indicator', () => {
    renderTable({ sort: 'km', order: 'asc' });
    // The active column button carries an aria-label describing the order;
    // non-active columns do not.
    expect(screen.getByRole('button', { name: /km.*crescente/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /data.*crescente/i })).not.toBeInTheDocument();
  });
});
