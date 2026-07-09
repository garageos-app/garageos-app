import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { InterventionHeader } from './InterventionHeader';
import { useHasRole } from '@/auth/useHasRole';
import type { InterventionDetail } from '@/queries/types';

vi.mock('@/auth/useHasRole', () => ({
  useHasRole: vi.fn(),
}));

vi.mock('./InterventionExportPdfButton', () => ({
  InterventionExportPdfButton: ({ interventionId }: { interventionId: string }) => (
    <button data-testid="export-pdf-stub" data-intervention-id={interventionId}>
      mock-export-pdf
    </button>
  ),
}));

const mockedUseHasRole = vi.mocked(useHasRole);

beforeEach(() => {
  // Default: super_admin — preserves existing test expectations.
  // Tests that need the mechanic case override per-test.
  mockedUseHasRole.mockReturnValue(true);
});

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
    description: 'Cambio olio e filtri.',
    internal_notes: null,
    checklist_items: [{ id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', label: 'Cambio olio' }],
    viewer_is_owner: true,
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
  it('active intervention renders heading (type name), garage_code, plate, date, km, type subtitle, and BOTH action buttons', () => {
    renderHeader(makeIntervention());

    // Heading = intervention type name (title field removed web-wide)
    expect(screen.getByRole('heading', { name: 'Tagliando' })).toBeInTheDocument();
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
    // Export PDF button always visible, receives the intervention id
    const stub = screen.getByTestId('export-pdf-stub');
    expect(stub).toBeInTheDocument();
    expect(stub).toHaveAttribute('data-intervention-id', '11111111-1111-1111-1111-111111111111');
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
    expect(screen.getByTestId('export-pdf-stub')).toBeInTheDocument();
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

  it('mechanic user (useHasRole=false) sees Modifica but NOT Annulla on active intervention', () => {
    mockedUseHasRole.mockReturnValue(false);
    renderHeader(makeIntervention());

    expect(screen.getByRole('button', { name: 'Modifica' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Annulla' })).not.toBeInTheDocument();
  });

  it('super_admin user (useHasRole=true) sees both Modifica and Annulla on active intervention', () => {
    // Default beforeEach mock already returns true — explicit here for clarity.
    mockedUseHasRole.mockReturnValue(true);
    renderHeader(makeIntervention());

    expect(screen.getByRole('button', { name: 'Modifica' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Annulla' })).toBeInTheDocument();
  });

  it('mechanic on cancelled intervention sees neither button (status gate dominates role gate)', () => {
    mockedUseHasRole.mockReturnValue(false);
    const cancelled = makeIntervention({
      status: 'cancelled',
      cancelled_at: '2025-06-02T10:00:00Z',
    });
    renderHeader(cancelled);

    expect(screen.queryByRole('button', { name: 'Modifica' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Annulla' })).not.toBeInTheDocument();
  });

  it('shows the export PDF button even when the intervention is cancelled', () => {
    const cancelled = makeIntervention({
      status: 'cancelled',
      cancelled_at: '2025-06-02T10:00:00Z',
      cancelled_reason: 'Errore inserimento',
    });
    renderHeader(cancelled);

    expect(screen.getByTestId('export-pdf-stub')).toBeInTheDocument();
    expect(screen.getByTestId('export-pdf-stub')).toHaveAttribute(
      'data-intervention-id',
      '11111111-1111-1111-1111-111111111111',
    );
    expect(screen.queryByRole('button', { name: 'Modifica' })).not.toBeInTheDocument();
  });
});
