import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { InterventionHeader } from './InterventionHeader';
import type { InterventionDetail } from '@/queries/types';

// Minimal fixture factory — only fields consumed by InterventionHeader.
function makeIntervention(overrides: Partial<InterventionDetail> = {}): InterventionDetail {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    status: 'active',
    is_disputed: false,
    wiki_window_open: true,
    intervention_date: '2025-06-01T09:00:00Z',
    odometer_km: 60000,
    created_at: '2025-06-01T09:00:00Z',
    cancelled_at: null,
    cancelled_reason: null,
    title: 'Tagliando 60k',
    description: 'Cambio olio e filtri.',
    internal_notes: null,
    parts_replaced: [],
    type: {
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      code: 'TAGLIANDO',
      name_it: 'Tagliando',
    },
    tenant: {
      id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      business_name: 'Officina Rossi',
    },
    location: {
      id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      name: 'Sede principale',
      city: 'Milano',
      address: 'Via Roma 1',
    },
    vehicle: {
      id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      garage_code: 'ROS-001',
      plate: 'AB123CD',
      make: 'Fiat',
      model: 'Panda',
    },
    created_by: {
      id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
      first_name: 'Mario',
      last_name: 'Rossi',
    },
    attachments: [],
    ...overrides,
  };
}

function renderHeader(
  intervention: InterventionDetail,
  onEditClick = vi.fn(),
  onCancelClick = vi.fn(),
) {
  return render(
    <MemoryRouter>
      <InterventionHeader
        intervention={intervention}
        onEditClick={onEditClick}
        onCancelClick={onCancelClick}
      />
    </MemoryRouter>,
  );
}

describe('InterventionHeader', () => {
  it('active intervention renders title, garage_code, plate, date, km, type subtitle, and BOTH action buttons', () => {
    renderHeader(makeIntervention());

    // Title
    expect(screen.getByRole('heading', { name: 'Tagliando 60k' })).toBeInTheDocument();
    // garage_code + plate crumb
    expect(screen.getByText(/ROS-001/)).toBeInTheDocument();
    expect(screen.getByText(/AB123CD/)).toBeInTheDocument();
    // Type subtitle (the subtitle div contains "Tagliando · 01/06/2025 · ...")
    expect(screen.getByText(/Tagliando.*01\/06\/2025/)).toBeInTheDocument();
    // Date (it-IT dd/mm/yyyy)
    expect(screen.getByText(/01\/06\/2025/)).toBeInTheDocument();
    // Km
    expect(screen.getByText(/60\.000 km/)).toBeInTheDocument();
    // Action buttons visible for active
    expect(screen.getByRole('button', { name: 'Modifica' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Annulla' })).toBeInTheDocument();
  });

  it('cancelled state hides action buttons and shows "Cancellato" badge', () => {
    const cancelled = makeIntervention({
      status: 'cancelled',
      cancelled_at: '2025-06-02T10:00:00Z',
      cancelled_reason: 'Errore inserimento',
    });
    renderHeader(cancelled);

    expect(screen.getByText('Cancellato')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Modifica' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Annulla' })).not.toBeInTheDocument();
  });

  it('disputed intervention shows "Disputa" badge', () => {
    const disputed = makeIntervention({ status: 'disputed', is_disputed: true });
    renderHeader(disputed);

    expect(screen.getByText('Disputa')).toBeInTheDocument();
  });

  it('click handlers fire when Modifica and Annulla are clicked', async () => {
    const user = userEvent.setup();
    const onEditClick = vi.fn();
    const onCancelClick = vi.fn();
    renderHeader(makeIntervention(), onEditClick, onCancelClick);

    await user.click(screen.getByRole('button', { name: 'Modifica' }));
    expect(onEditClick).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Annulla' }));
    expect(onCancelClick).toHaveBeenCalledTimes(1);
  });
});
