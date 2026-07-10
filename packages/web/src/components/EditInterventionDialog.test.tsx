import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { EditInterventionDialog, partsEqual } from './EditInterventionDialog';
import { ApiError } from '@/lib/api-client';
import type { InterventionDetail, ShopTimelineItem } from '@/queries/types';

const { mockApiFetch, mockToastSuccess, mockToastError, mockUseInterventionDetail, mockRefetch } =
  vi.hoisted(() => ({
    mockApiFetch: vi.fn(),
    mockToastSuccess: vi.fn(),
    mockToastError: vi.fn(),
    mockUseInterventionDetail: vi.fn(),
    mockRefetch: vi.fn(),
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

// interventionTypeId and checklist item ids go through Zod's z.uuid(),
// which (zod v4) validates the version/variant nibbles — use well-formed
// v4-shaped literals (mirrors InterventionForm.test.tsx convention).
const TYPE_ID_TAGLIANDO = '11111111-1111-4111-8111-111111111111';
const TYPE_ID_GOMME = '22222222-2222-4222-8222-222222222222';
const ITEM_ID_OLIO = 'aaaaaaaa-0000-4000-8000-000000000001';
const ITEM_ID_FILTRO = 'aaaaaaaa-0000-4000-8000-000000000002';
const ITEM_ID_CANDELE = 'aaaaaaaa-0000-4000-8000-000000000003';
const ITEM_ID_GOMME_CHK = 'dddddddd-0000-4000-8000-000000000001';

// Module-level mock of the intervention-types query so the dialog can
// render the <Select> and the per-type checklist without a network round
// trip. jsdom's Radix Select limitations are worked around globally by the
// pointer-capture/scrollIntoView polyfills in tests/setup.ts, so the type
// change (Tier-2 case 3) drives the real <Select> via userEvent.
vi.mock('@/queries/interventionTypes', () => ({
  useInterventionTypes: () => ({
    data: {
      data: [
        {
          id: TYPE_ID_TAGLIANDO,
          code: 'tagliando',
          nameIt: 'Tagliando',
          description: '',
          icon: '',
          suggestsDeadline: true,
          defaultDeadlineMonths: 12,
          defaultDeadlineKm: 15000,
          custom: false,
          checklistItems: [
            { id: ITEM_ID_OLIO, code: 'OLIO', nameIt: 'Cambio olio', sortOrder: 1 },
            { id: ITEM_ID_FILTRO, code: 'FILTRO', nameIt: 'Cambio filtro', sortOrder: 2 },
            { id: ITEM_ID_CANDELE, code: 'CANDELE', nameIt: 'Cambio candele', sortOrder: 3 },
          ],
        },
        {
          id: TYPE_ID_GOMME,
          code: 'gomme',
          nameIt: 'Cambio gomme',
          description: '',
          icon: '',
          suggestsDeadline: false,
          defaultDeadlineMonths: null,
          defaultDeadlineKm: null,
          custom: false,
          checklistItems: [
            {
              id: ITEM_ID_GOMME_CHK,
              code: 'GOMME_CHK',
              nameIt: 'Sostituzione gomme',
              sortOrder: 1,
            },
          ],
        },
      ],
    },
    isPending: false,
    isError: false,
  }),
}));

vi.mock('@/queries/interventionDetail', async () => {
  const actual = await vi.importActual<typeof import('@/queries/interventionDetail')>(
    '@/queries/interventionDetail',
  );
  return {
    ...actual,
    useInterventionDetail: mockUseInterventionDetail,
  };
});

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
    type: { id: TYPE_ID_TAGLIANDO, code: 'tagliando', name_it: 'Tagliando' },
    description: 'Olio motore + filtri',
    parts_replaced_count: 2,
    status: 'active',
    is_disputed: false,
    wiki_window_open: true,
    tenant: { id: 'tenant-acme', business_name: 'Garage Acme' },
    ...overrides,
  };
}

function makeDetail(overrides: Partial<InterventionDetail> = {}): InterventionDetail {
  return {
    id: 'i-1',
    status: 'active',
    is_disputed: false,
    wiki_window_open: true,
    intervention_date: '2026-05-10',
    odometer_km: 50000,
    created_at: '2026-05-10T10:00:00Z',
    cancelled_at: null,
    cancelled_reason: null,
    description: 'Olio motore + filtri',
    internal_notes: null,
    // BR-303 — pre-check matches the type's first two catalog items
    // (ITEM_ID_OLIO, ITEM_ID_FILTRO); ITEM_ID_CANDELE is left unchecked by
    // default so Tier-2 case 2 (replace-set) has an item to select.
    checklist_items: [
      { id: ITEM_ID_OLIO, label: 'Cambio olio' },
      { id: ITEM_ID_FILTRO, label: 'Cambio filtro' },
    ],
    parts_replaced: [],
    type: { id: TYPE_ID_TAGLIANDO, code: 'tagliando', name_it: 'Tagliando' },
    tenant: { id: 't-1', business_name: 'Garage Acme' },
    vehicle: { id: 'v-1', garage_code: 'ACM-0001', plate: 'AB123CD', make: 'Fiat', model: 'Panda' },
    created_by: null,
    ...overrides,
  };
}

describe('EditInterventionDialog', () => {
  beforeEach(() => {
    mockApiFetch.mockClear();
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
    mockUseInterventionDetail.mockReset();
    mockRefetch.mockClear();
    // Default: detail resolves successfully with the same fixture content as
    // the timeline item used by existing tests. Individual tests override
    // this with mockReturnValueOnce when they need loading / error states.
    mockUseInterventionDetail.mockReturnValue({
      data: makeDetail(),
      isPending: false,
      isError: false,
      refetch: mockRefetch,
    });
  });

  it('renders pre-populated form values from detail prefetch', () => {
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
  });

  it('renders "Modifiche libere" banner when wiki_window_open is true', () => {
    render(
      <EditInterventionDialog
        intervention={makeShopItem({ wiki_window_open: true })}
        vehicleId="v-1"
        open={true}
        onOpenChange={() => {}}
      />,
      { wrapper: wrap },
    );
    expect(screen.getByText(/modifiche libere/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/motivo della modifica/i)).not.toBeInTheDocument();
  });

  it('renders "Audit attivo" banner and reason field when wiki_window_open is false', () => {
    render(
      <EditInterventionDialog
        intervention={makeShopItem({ wiki_window_open: false })}
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
        intervention={makeShopItem({ wiki_window_open: false })}
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

  it('handles 404 NOT_FOUND (RLS-as-404): shows toast and closes dialog', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    mockApiFetch.mockRejectedValueOnce(
      new ApiError('NOT_FOUND', 404, 'The requested resource does not exist or is not accessible.'),
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
      expect(mockToastError).toHaveBeenCalledWith('Intervento non trovato.');
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
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

  it('shows skeleton placeholder while detail is loading', () => {
    mockUseInterventionDetail.mockReturnValue({
      data: undefined,
      isPending: true,
      isError: false,
      refetch: mockRefetch,
    });
    render(
      <EditInterventionDialog
        intervention={makeShopItem()}
        vehicleId="v-1"
        open={true}
        onOpenChange={() => {}}
      />,
      { wrapper: wrap },
    );
    // The form body is not mounted: no description textarea, no Salva button.
    expect(screen.queryByLabelText(/descrizione/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /salva/i })).not.toBeInTheDocument();
    // The shell still shows the dialog title and an Annulla button (disabled).
    expect(screen.getByText(/modifica intervento/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /annulla/i })).toBeDisabled();
    // Skeleton placeholder is present (we'll use a role + aria-label assertion).
    expect(screen.getByRole('status', { name: /caricamento/i })).toBeInTheDocument();
  });

  it('shows error alert with Riprova when detail fetch fails', async () => {
    const user = userEvent.setup();
    mockUseInterventionDetail.mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
      refetch: mockRefetch,
    });
    render(
      <EditInterventionDialog
        intervention={makeShopItem()}
        vehicleId="v-1"
        open={true}
        onOpenChange={() => {}}
      />,
      { wrapper: wrap },
    );
    expect(screen.getByText(/impossibile caricare l'intervento\. riprova\./i)).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: /riprova/i });
    await user.click(retry);
    expect(mockRefetch).toHaveBeenCalledTimes(1);
    // Form body still not mounted.
    expect(screen.queryByLabelText(/descrizione/i)).not.toBeInTheDocument();
  });

  it('preserves existing parts when user adds a new one (no data loss)', async () => {
    // Setup: the detail has 1 existing part. The user expands the section,
    // sees the existing part rendered, adds a second, and submits.
    // Pre-fix bug: defaults were [], so submitting sent only [newPart] which
    // overwrote the existing one. Post-fix: defaults are detail.parts_replaced,
    // so submitting sends [existingPart, newPart].
    const user = userEvent.setup();
    const existingPart = {
      name: 'Filtro olio',
      code: 'F1',
      quantity: 1,
      notes: null,
    };
    mockUseInterventionDetail.mockReturnValue({
      data: makeDetail({ parts_replaced: [existingPart] }),
      isPending: false,
      isError: false,
      refetch: mockRefetch,
    });
    mockApiFetch.mockResolvedValueOnce({ intervention: { id: 'i-1' }, revision: null });

    render(
      <EditInterventionDialog
        intervention={makeShopItem()}
        vehicleId="v-1"
        open={true}
        onOpenChange={() => {}}
      />,
      { wrapper: wrap },
    );

    await user.click(screen.getByRole('button', { name: /modifica pezzi sostituiti/i }));
    // PartsRepeater exposes "Aggiungi pezzo" to push a new row. Inputs use
    // placeholder text, not <label>, so we query by placeholder.
    await user.click(screen.getByRole('button', { name: /aggiungi pezzo/i }));
    // Two name inputs are now rendered: index 0 (existing, "Filtro olio")
    // and index 1 (new, empty).
    const nameInputs = screen.getAllByPlaceholderText(/nome pezzo/i);
    expect(nameInputs).toHaveLength(2);
    await user.type(nameInputs[1], 'Pastiglie freno');
    const qtyInputs = screen.getAllByPlaceholderText(/quantità/i);
    await user.clear(qtyInputs[1]);
    await user.type(qtyInputs[1], '4');

    await user.click(screen.getByRole('button', { name: /salva/i }));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalled();
    });
    const [, callOptions] = mockApiFetch.mock.calls[0];
    const body = JSON.parse(callOptions.body) as Record<string, unknown>;
    const parts = body.partsReplaced as Array<{ name: string; quantity: number }>;
    expect(parts).toHaveLength(2);
    expect(parts[0].name).toBe('Filtro olio');
    expect(parts[1].name).toBe('Pastiglie freno');
    expect(parts[1].quantity).toBe(4);
  });

  it('preserves existing internal notes when user edits the field (no data loss)', async () => {
    const user = userEvent.setup();
    mockUseInterventionDetail.mockReturnValue({
      data: makeDetail({ internal_notes: 'Esistente: ricontrollare freni' }),
      isPending: false,
      isError: false,
      refetch: mockRefetch,
    });
    mockApiFetch.mockResolvedValueOnce({ intervention: { id: 'i-1' }, revision: null });

    render(
      <EditInterventionDialog
        intervention={makeShopItem()}
        vehicleId="v-1"
        open={true}
        onOpenChange={() => {}}
      />,
      { wrapper: wrap },
    );

    // Mi3: notes section is auto-expanded because internal_notes is non-null;
    // no expander click needed. The textarea is hydrated with the existing text. User appends.
    const notes = screen.getByLabelText(/note interne/i);
    expect(notes).toHaveValue('Esistente: ricontrollare freni');
    await user.type(notes, ' + verificare olio');
    await user.click(screen.getByRole('button', { name: /salva/i }));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalled();
    });
    const [, callOptions] = mockApiFetch.mock.calls[0];
    const body = JSON.parse(callOptions.body) as Record<string, unknown>;
    expect(body.internalNotes).toBe('Esistente: ricontrollare freni + verificare olio');
  });

  it('omits partsReplaced from PATCH when expanded but unchanged', async () => {
    const user = userEvent.setup();
    const existingPart = {
      name: 'Filtro olio',
      code: 'F1',
      quantity: 1,
      notes: 'OEM',
    };
    mockUseInterventionDetail.mockReturnValue({
      data: makeDetail({ parts_replaced: [existingPart] }),
      isPending: false,
      isError: false,
      refetch: mockRefetch,
    });
    mockApiFetch.mockResolvedValueOnce({ intervention: { id: 'i-1' }, revision: null });

    render(
      <EditInterventionDialog
        intervention={makeShopItem()}
        vehicleId="v-1"
        open={true}
        onOpenChange={() => {}}
      />,
      { wrapper: wrap },
    );

    await user.click(screen.getByRole('button', { name: /modifica pezzi sostituiti/i }));
    // User does NOT modify any row. Makes an unrelated change and submits.
    await user.clear(screen.getByLabelText(/descrizione/i));
    await user.type(screen.getByLabelText(/descrizione/i), 'Nuovo testo');
    await user.click(screen.getByRole('button', { name: /salva/i }));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalled();
    });
    const [, callOptions] = mockApiFetch.mock.calls[0];
    const body = JSON.parse(callOptions.body) as Record<string, unknown>;
    expect(body).not.toHaveProperty('partsReplaced');
  });

  it('omits internalNotes from PATCH when notes section expanded but unchanged', async () => {
    const user = userEvent.setup();
    mockUseInterventionDetail.mockReturnValue({
      data: makeDetail({ internal_notes: 'Nota originale' }),
      isPending: false,
      isError: false,
      refetch: mockRefetch,
    });
    mockApiFetch.mockResolvedValueOnce({ intervention: { id: 'i-1' }, revision: null });

    render(
      <EditInterventionDialog
        intervention={makeShopItem()}
        vehicleId="v-1"
        open={true}
        onOpenChange={() => {}}
      />,
      { wrapper: wrap },
    );

    // Mi3: notes section is auto-expanded because internal_notes is non-null;
    // no expander click needed. User does NOT modify the notes.
    // Makes an unrelated change and submits.
    await user.clear(screen.getByLabelText(/descrizione/i));
    await user.type(screen.getByLabelText(/descrizione/i), 'Nuovo testo');
    await user.click(screen.getByRole('button', { name: /salva/i }));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalled();
    });
    const [, callOptions] = mockApiFetch.mock.calls[0];
    const body = JSON.parse(callOptions.body) as Record<string, unknown>;
    expect(body).not.toHaveProperty('internalNotes');
  });

  it('auto-expands notes section when detail.internal_notes is non-null', () => {
    // Mirror of the existing showTitle auto-expand behavior. The expander
    // toggle should NOT need to be clicked to reveal the textarea.
    mockUseInterventionDetail.mockReturnValue({
      data: makeDetail({ internal_notes: 'Sostituita la frizione' }),
      isPending: false,
      isError: false,
      refetch: mockRefetch,
    });
    render(
      <EditInterventionDialog
        intervention={makeShopItem()}
        vehicleId="v-1"
        open={true}
        onOpenChange={() => {}}
      />,
      { wrapper: wrap },
    );
    // The "Modifica note interne" toggle button should NOT be present because
    // the section is auto-expanded; the textarea should be visible instead.
    expect(
      screen.queryByRole('button', { name: /modifica note interne/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('Sostituita la frizione')).toBeInTheDocument();
  });

  it('race-window: PATCH revision_reason_required switches banner to "Audit appena attivato"', async () => {
    const user = userEvent.setup();
    mockApiFetch.mockRejectedValueOnce(
      new ApiError('intervention.modification.revision_reason_required', 400, 'Reason required'),
    );
    render(
      <EditInterventionDialog
        intervention={makeShopItem({ wiki_window_open: true })}
        vehicleId="v-1"
        open={true}
        onOpenChange={() => {}}
      />,
      { wrapper: wrap },
    );
    // Banner pre-submit: "Modifiche libere".
    expect(screen.getByText(/modifiche libere/i)).toBeInTheDocument();
    // User makes an edit + submits — backend says window just closed.
    await user.clear(screen.getByLabelText(/descrizione/i));
    await user.type(screen.getByLabelText(/descrizione/i), 'Nuovo testo');
    await user.click(screen.getByRole('button', { name: /salva/i }));
    // Banner switches to the "race-window" warning variant.
    await waitFor(() => {
      expect(screen.getByText(/audit appena attivato/i)).toBeInTheDocument();
    });
    // "Modifiche libere" banner is no longer present.
    expect(screen.queryByText(/modifiche libere/i)).not.toBeInTheDocument();
  });

  it('race-window: after server-driven switch, reason field is mounted', async () => {
    const user = userEvent.setup();
    mockApiFetch.mockRejectedValueOnce(
      new ApiError('intervention.modification.revision_reason_required', 400, 'Reason required'),
    );
    render(
      <EditInterventionDialog
        intervention={makeShopItem({ wiki_window_open: true })}
        vehicleId="v-1"
        open={true}
        onOpenChange={() => {}}
      />,
      { wrapper: wrap },
    );
    // Pre-submit: reason field is NOT in DOM (free-edit mode).
    expect(screen.queryByLabelText(/motivo della modifica/i)).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText(/descrizione/i));
    await user.type(screen.getByLabelText(/descrizione/i), 'Nuovo');
    await user.click(screen.getByRole('button', { name: /salva/i }));
    // Post-failed-submit: reason field is mounted.
    await waitFor(() => {
      expect(screen.getByLabelText(/motivo della modifica/i)).toBeInTheDocument();
    });
  });

  it('race-window: after switch, submitting with reason >=10 char succeeds', async () => {
    const user = userEvent.setup();
    // First submit fails (race-window detected by server).
    mockApiFetch.mockRejectedValueOnce(
      new ApiError('intervention.modification.revision_reason_required', 400, 'Reason required'),
    );
    // Second submit (with reason) succeeds.
    mockApiFetch.mockResolvedValueOnce({
      intervention: { id: 'i-1' },
      revision: { id: 'rev-1' },
    });
    const onOpenChange = vi.fn();
    render(
      <EditInterventionDialog
        intervention={makeShopItem({ wiki_window_open: true })}
        vehicleId="v-1"
        open={true}
        onOpenChange={onOpenChange}
      />,
      { wrapper: wrap },
    );
    await user.clear(screen.getByLabelText(/descrizione/i));
    await user.type(screen.getByLabelText(/descrizione/i), 'Nuovo');
    await user.click(screen.getByRole('button', { name: /salva/i }));
    // Reason field mounts after the failed PATCH.
    const reasonField = await screen.findByLabelText(/motivo della modifica/i);
    await user.type(reasonField, 'Audit attivato durante modifica');
    await user.click(screen.getByRole('button', { name: /salva/i }));
    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalledWith('Intervento aggiornato');
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // The second PATCH body includes the reason field.
    expect(mockApiFetch).toHaveBeenCalledTimes(2);
    const [, secondCallOptions] = mockApiFetch.mock.calls[1];
    const body = JSON.parse(secondCallOptions.body) as Record<string, unknown>;
    expect(body).toHaveProperty('reason', 'Audit attivato durante modifica');
  });

  describe('checklist replace-set (Task 4)', () => {
    it('pre-checks the checklist items already on the intervention, no Titolo field', () => {
      render(
        <EditInterventionDialog
          intervention={makeShopItem()}
          vehicleId="v-1"
          open={true}
          onOpenChange={() => {}}
        />,
        { wrapper: wrap },
      );
      expect(screen.getByLabelText('Cambio olio')).toBeChecked();
      expect(screen.getByLabelText('Cambio filtro')).toBeChecked();
      // Third catalog item for the type is rendered but not pre-checked.
      expect(screen.getByLabelText('Cambio candele')).not.toBeChecked();
      expect(screen.queryByLabelText(/titolo/i)).not.toBeInTheDocument();
    });

    it('sends the new checklistItemIds set on the PATCH when items are toggled', async () => {
      const user = userEvent.setup();
      mockApiFetch.mockResolvedValueOnce({ intervention: { id: 'i-1' }, revision: null });
      render(
        <EditInterventionDialog
          intervention={makeShopItem()}
          vehicleId="v-1"
          open={true}
          onOpenChange={() => {}}
        />,
        { wrapper: wrap },
      );
      // Deselect "Cambio olio" (pre-checked) and select "Cambio candele"
      // (pre-unchecked) — a replace-set, not a partial diff.
      await user.click(screen.getByLabelText('Cambio olio'));
      await user.click(screen.getByLabelText('Cambio candele'));
      await user.click(screen.getByRole('button', { name: /salva/i }));

      await waitFor(() => {
        expect(mockApiFetch).toHaveBeenCalled();
      });
      const [, callOptions] = mockApiFetch.mock.calls[0];
      const body = JSON.parse(callOptions.body) as Record<string, unknown>;
      const ids = (body.checklistItemIds as string[]).slice().sort();
      expect(ids).toEqual([ITEM_ID_CANDELE, ITEM_ID_FILTRO].sort());
    });

    it('resets checklistItemIds and shows the new type checklist when the type changes', async () => {
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
      // Sanity: Tagliando's checklist is pre-checked before the type change.
      expect(screen.getByLabelText('Cambio olio')).toBeChecked();

      await user.click(screen.getByLabelText(/tipo intervento/i));
      await user.click(await screen.findByRole('option', { name: /cambio gomme/i }));

      // The new type's checklist item is rendered, unchecked (reset).
      expect(screen.getByLabelText('Sostituzione gomme')).not.toBeChecked();
      // The old type's items are no longer rendered.
      expect(screen.queryByLabelText('Cambio olio')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Cambio filtro')).not.toBeInTheDocument();
    });
  });

  describe('partsEqual structural compare', () => {
    it('treats arrays with shifted key order as equal', () => {
      const a = [{ name: 'Filtro olio', code: 'F1', quantity: 1, notes: 'OEM' }];
      // Same content, different key insertion order (simulates Prisma JSON
      // serializer vs Zod parse divergence).
      const b = [{ quantity: 1, notes: 'OEM', name: 'Filtro olio', code: 'F1' }];
      expect(partsEqual(a, b)).toBe(true);
    });

    it('returns false when length differs', () => {
      const a = [{ name: 'A', code: null, quantity: 1, notes: null }];
      const b: typeof a = [];
      expect(partsEqual(a, b)).toBe(false);
    });

    it('returns false when a single field differs', () => {
      const a = [{ name: 'A', code: 'X', quantity: 1, notes: null }];
      const b = [{ name: 'A', code: 'X', quantity: 2, notes: null }];
      expect(partsEqual(a, b)).toBe(false);
    });

    it('treats undefined and null as equivalent for nullable fields', () => {
      const a = [{ name: 'A', code: undefined, quantity: 1, notes: undefined }];
      const b = [{ name: 'A', code: null, quantity: 1, notes: null }];
      expect(partsEqual(a, b as unknown as typeof a)).toBe(true);
    });
  });
});
