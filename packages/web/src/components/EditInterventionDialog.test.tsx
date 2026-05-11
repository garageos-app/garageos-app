import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { EditInterventionDialog } from './EditInterventionDialog';
import { ApiError } from '@/lib/api-client';
import type { ShopTimelineItem } from '@/queries/types';

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

// Module-level mock of the intervention-types query so the dialog can
// render the <Select> without a network round trip. JSDOM does not
// open Radix Select portals reliably; we test the Select's value
// indirectly via the submitted PATCH body.
vi.mock('@/queries/interventionTypes', () => ({
  useInterventionTypes: () => ({
    data: {
      data: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          code: 'tagliando',
          nameIt: 'Tagliando',
          description: '',
          icon: '',
          category: 'maintenance',
          suggestsDeadline: true,
          defaultDeadlineMonths: 12,
          defaultDeadlineKm: 15000,
        },
        {
          id: '22222222-2222-4222-8222-222222222222',
          code: 'gomme',
          nameIt: 'Cambio gomme',
          description: '',
          icon: '',
          category: 'tires',
          suggestsDeadline: false,
          defaultDeadlineMonths: null,
          defaultDeadlineKm: null,
        },
      ],
    },
    isPending: false,
    isError: false,
  }),
}));

function wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function makeShopItem(overrides: Partial<ShopTimelineItem> = {}): ShopTimelineItem {
  return {
    kind: 'shop_intervention',
    id: 'i-1',
    intervention_date: '2026-05-10',
    odometer_km: 50000,
    type: { id: '11111111-1111-4111-8111-111111111111', code: 'tagliando', name_it: 'Tagliando' },
    title: 'Tagliando 50k',
    description: 'Olio motore + filtri',
    parts_replaced_count: 2,
    status: 'active',
    is_disputed: false,
    wiki_locked_at: null,
    tenant: { business_name: 'Garage Acme', location_city: 'Milano' },
    has_attachments: false,
    attachments_count: 0,
    ...overrides,
  };
}

describe('EditInterventionDialog', () => {
  beforeEach(() => {
    mockApiFetch.mockClear();
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
  });

  it('renders pre-populated form values from intervention prop', () => {
    render(
      <EditInterventionDialog
        intervention={makeShopItem()}
        vehicleId="v-1"
        open={true}
        onOpenChange={() => {}}
      />,
      { wrapper: wrap },
    );
    expect(screen.getByLabelText(/descrizione/i)).toHaveValue('Olio motore + filtri');
    // Title section is auto-expanded because intervention.title is non-null.
    expect(screen.getByLabelText(/titolo/i)).toHaveValue('Tagliando 50k');
  });

  it('renders "Modifiche libere" banner when wiki_locked_at is null', () => {
    render(
      <EditInterventionDialog
        intervention={makeShopItem({ wiki_locked_at: null })}
        vehicleId="v-1"
        open={true}
        onOpenChange={() => {}}
      />,
      { wrapper: wrap },
    );
    expect(screen.getByText(/modifiche libere/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/motivo della modifica/i)).not.toBeInTheDocument();
  });

  it('renders "Audit attivo" banner and reason field when wiki_locked_at is set', () => {
    render(
      <EditInterventionDialog
        intervention={makeShopItem({ wiki_locked_at: '2026-05-01T10:00:00.000Z' })}
        vehicleId="v-1"
        open={true}
        onOpenChange={() => {}}
      />,
      { wrapper: wrap },
    );
    expect(screen.getByText(/audit attivo/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/motivo della modifica/i)).toBeInTheDocument();
  });

  it('blocks submit when no fields changed (form-level error, no mutation)', async () => {
    const user = userEvent.setup();
    render(
      <EditInterventionDialog
        intervention={makeShopItem()}
        vehicleId="v-1"
        open={true}
        onOpenChange={() => {}}
      />,
      { wrapper: wrap },
    );
    await user.click(screen.getByRole('button', { name: /salva/i }));
    expect(await screen.findByText(/nessuna modifica da salvare/i)).toBeInTheDocument();
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('submits wiki-window edit (no reason in body), success toast + closes', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    mockApiFetch.mockResolvedValueOnce({ intervention: { id: 'i-1' }, revision: null });
    render(
      <EditInterventionDialog
        intervention={makeShopItem()}
        vehicleId="v-1"
        open={true}
        onOpenChange={onOpenChange}
      />,
      { wrapper: wrap },
    );
    await user.clear(screen.getByLabelText(/descrizione/i));
    await user.type(screen.getByLabelText(/descrizione/i), 'Nuovo testo');
    await user.click(screen.getByRole('button', { name: /salva/i }));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/v1/interventions/i-1', {
        method: 'PATCH',
        body: JSON.stringify({ description: 'Nuovo testo' }),
      });
    });
    expect(mockToastSuccess).toHaveBeenCalledWith('Intervento aggiornato');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('blocks locked submit when reason < 10 chars (inline error, no mutation)', async () => {
    const user = userEvent.setup();
    render(
      <EditInterventionDialog
        intervention={makeShopItem({ wiki_locked_at: '2026-05-01T10:00:00.000Z' })}
        vehicleId="v-1"
        open={true}
        onOpenChange={() => {}}
      />,
      { wrapper: wrap },
    );
    await user.clear(screen.getByLabelText(/descrizione/i));
    await user.type(screen.getByLabelText(/descrizione/i), 'Nuovo');
    await user.type(screen.getByLabelText(/motivo della modifica/i), 'corto');
    await user.click(screen.getByRole('button', { name: /salva/i }));

    expect(await screen.findByText(/almeno 10 caratteri/i)).toBeInTheDocument();
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('handles 422 disputed: shows toast and closes dialog', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    mockApiFetch.mockRejectedValueOnce(
      new ApiError('intervention.modification.disputed', 422, 'disputed'),
    );
    render(
      <EditInterventionDialog
        intervention={makeShopItem()}
        vehicleId="v-1"
        open={true}
        onOpenChange={onOpenChange}
      />,
      { wrapper: wrap },
    );
    await user.clear(screen.getByLabelText(/descrizione/i));
    await user.type(screen.getByLabelText(/descrizione/i), 'Modifica');
    await user.click(screen.getByRole('button', { name: /salva/i }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        'Intervento contestato: rispondi alla disputa prima di modificare.',
      );
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
