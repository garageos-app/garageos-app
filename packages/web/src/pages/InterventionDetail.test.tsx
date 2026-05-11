// IT-strings — test assertions mirror IT copy in the component.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { InterventionDetail } from './InterventionDetail';
import { ApiError } from '@/lib/api-client';
import type {
  InterventionDetail as InterventionDetailDto,
  InterventionDispute,
  InterventionRevision,
} from '@/queries/types';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { apiFetchMock, navigateMock, toastErrorMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  navigateMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
  return {
    ...actual,
    useApiFetch: () => apiFetchMock,
  };
});

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock('sonner', () => ({
  toast: { error: toastErrorMock, success: vi.fn() },
}));

// Module-mock the two dialogs so they don't need their own query setup.
// CancelInterventionDialog is tracked by its `open` prop so test 10 can
// verify it receives open=true after the "Annulla" button is clicked.
const cancelDialogOpenValues: boolean[] = [];
vi.mock('@/components/CancelInterventionDialog', () => ({
  CancelInterventionDialog: ({ open }: { open: boolean }) => {
    cancelDialogOpenValues.push(open);
    return open ? <div data-testid="cancel-dialog-open" /> : null;
  },
}));

vi.mock('@/components/EditInterventionDialog', () => ({
  EditInterventionDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="edit-dialog-open" /> : null,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const INTERVENTION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VEHICLE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TENANT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const BASE_DETAIL: InterventionDetailDto = {
  id: INTERVENTION_ID,
  status: 'active',
  is_disputed: false,
  wiki_window_open: true,
  intervention_date: '2025-03-15T10:00:00Z',
  odometer_km: 30200,
  created_at: '2025-03-15T10:00:00Z',
  cancelled_at: null,
  cancelled_reason: null,
  title: 'Tagliando 30000 km',
  description: 'Cambio olio e filtri.',
  internal_notes: null,
  parts_replaced: [],
  type: { id: 'type-tagliando', code: 'TAGLIANDO', name_it: 'Tagliando' },
  tenant: { id: TENANT_ID, business_name: 'Officina Rossi' },
  location: { id: 'loc-1', name: 'Sede centrale', city: 'Milano', address: null },
  vehicle: {
    id: VEHICLE_ID,
    garage_code: 'GO-234-ABCD',
    plate: 'AB123CD',
    make: 'Fiat',
    model: 'Panda',
  },
  created_by: { id: 'user-1', first_name: 'Mario', last_name: 'Bianchi' },
  attachments: [],
};

const DISPUTE_FIXTURE: InterventionDispute = {
  id: 'disp-1',
  status: 'open',
  reasonCategory: 'not_performed',
  customerDescription: 'Lavoro non eseguito.',
  tenantResponse: null,
  tenantResponseAt: null,
  tenantResponseUser: null,
  createdAt: '2025-03-16T08:00:00Z',
  resolvedAt: null,
};

const REVISION_FIXTURE: InterventionRevision = {
  id: 'rev-1',
  revised_at: '2025-03-16T09:00:00Z',
  reason: 'Correzione descrizione.',
  changes: { description: { before: 'Cambio olio.', after: 'Cambio olio e filtri.' } },
  user: { id: 'user-1', first_name: 'Mario', last_name: 'Bianchi' },
};

// ---------------------------------------------------------------------------
// Helper: wire apiFetchMock for the 3 parallel queries
// ---------------------------------------------------------------------------

type SetupOpts = {
  detail?: InterventionDetailDto | ApiError;
  disputes?: InterventionDispute[];
  revisions?: InterventionRevision[];
};

function setupApiFetch({ detail, disputes, revisions }: SetupOpts) {
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (path: string) => {
    if (path === `/v1/interventions/${INTERVENTION_ID}`) {
      if (detail instanceof ApiError) throw detail;
      if (detail) return detail;
      throw new Error(`no detail fixture for: ${path}`);
    }
    if (path === `/v1/interventions/${INTERVENTION_ID}/disputes`) {
      // useInterventionDisputes queryFn unwraps res.disputes internally —
      // return the wire envelope so the hook gets the array it expects.
      return { disputes: disputes ?? [] };
    }
    if (path === `/v1/interventions/${INTERVENTION_ID}/revisions`) {
      return {
        data: revisions ?? [],
        meta: { has_more: false },
      };
    }
    throw new Error(`unexpected path: ${path}`);
  });
}

// ---------------------------------------------------------------------------
// Wrapper
// ---------------------------------------------------------------------------

function wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={[`/interventions/${INTERVENTION_ID}`]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/interventions/:id" element={children} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InterventionDetail', () => {
  beforeEach(() => {
    navigateMock.mockClear();
    toastErrorMock.mockClear();
    cancelDialogOpenValues.length = 0;
  });

  afterEach(() => {
    apiFetchMock.mockReset();
  });

  // 1. Skeleton while detail.isPending
  it('renders skeleton while detail is loading', () => {
    apiFetchMock.mockImplementation(() => new Promise(() => {})); // never resolves
    render(wrap({ children: <InterventionDetail /> }));
    expect(document.querySelector('[data-testid="detail-skeleton"]')).toBeInTheDocument();
  });

  // 2. 404 → toast.error + navigate('/')
  it('toasts and navigates to / on 404', async () => {
    setupApiFetch({
      detail: new ApiError('NOT_FOUND', 404, 'not found'),
    });
    render(wrap({ children: <InterventionDetail /> }));
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith('Intervento non trovato.'));
    expect(navigateMock).toHaveBeenCalledWith('/', { replace: true });
  });

  // 3. Happy path renders all sections
  it('renders header, stats tiles, and section cards on happy path', async () => {
    setupApiFetch({
      detail: BASE_DETAIL,
      disputes: [DISPUTE_FIXTURE],
      revisions: [REVISION_FIXTURE],
    });
    render(wrap({ children: <InterventionDetail /> }));

    // h1 title
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /Tagliando 30000 km/i })).toBeInTheDocument(),
    );

    // stats tiles
    expect(screen.getByText('Officina Rossi')).toBeInTheDocument();
    expect(screen.getByText(/Milano/)).toBeInTheDocument();
    expect(screen.getByText('Mario Bianchi')).toBeInTheDocument();

    // description card
    expect(screen.getByText('Descrizione')).toBeInTheDocument();
    // Description text also appears in the revision diff "after" span — use getAllBy.
    expect(screen.getAllByText('Cambio olio e filtri.').length).toBeGreaterThan(0);

    // dispute card (via DisputeThreadSection)
    expect(screen.getByText('Contestazione')).toBeInTheDocument();

    // revision card (via RevisionHistorySection)
    expect(screen.getByText(/Cronologia modifiche/)).toBeInTheDocument();
  });

  // 4. Hides Disputes section when disputes empty
  it('hides Contestazione section when disputes list is empty', async () => {
    setupApiFetch({ detail: BASE_DETAIL, disputes: [], revisions: [] });
    render(wrap({ children: <InterventionDetail /> }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /Tagliando 30000 km/i })).toBeInTheDocument(),
    );
    expect(screen.queryByText('Contestazione')).not.toBeInTheDocument();
  });

  // 5. Hides Revisions section when revisions empty
  it('hides Cronologia modifiche section when revisions list is empty', async () => {
    setupApiFetch({ detail: BASE_DETAIL, disputes: [], revisions: [] });
    render(wrap({ children: <InterventionDetail /> }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /Tagliando 30000 km/i })).toBeInTheDocument(),
    );
    expect(screen.queryByText(/Cronologia modifiche/)).not.toBeInTheDocument();
  });

  // 6. Renders Cancellation card when status='cancelled'
  it('shows Annullamento card when status is cancelled', async () => {
    const cancelled: InterventionDetailDto = {
      ...BASE_DETAIL,
      status: 'cancelled',
      cancelled_at: '2025-03-20T12:00:00Z',
      cancelled_reason: 'Cliente ha rinunciato ai lavori.',
    };
    setupApiFetch({ detail: cancelled, disputes: [], revisions: [] });
    render(wrap({ children: <InterventionDetail /> }));
    await waitFor(() => expect(screen.getByText('Annullamento')).toBeInTheDocument());
    expect(screen.getByText('Cliente ha rinunciato ai lavori.')).toBeInTheDocument();
  });

  // 7. Hides Modifica + Annulla buttons when status !== 'active'
  it('hides Modifica and Annulla buttons when status is cancelled', async () => {
    const cancelled: InterventionDetailDto = {
      ...BASE_DETAIL,
      status: 'cancelled',
      cancelled_at: '2025-03-20T12:00:00Z',
      cancelled_reason: 'Motivo qualsiasi.',
    };
    setupApiFetch({ detail: cancelled, disputes: [], revisions: [] });
    render(wrap({ children: <InterventionDetail /> }));
    await waitFor(() => expect(screen.getByText('Annullamento')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Modifica/i })).not.toBeInTheDocument();
    // "Annulla" button in the header (not the one inside CancelDialog)
    expect(screen.queryByRole('button', { name: /^Annulla$/i })).not.toBeInTheDocument();
  });

  // 8. Shows "Audit attivo" banner when wiki_window_open=false
  it('shows "Audit attivo" banner when wiki_window_open is false', async () => {
    const locked: InterventionDetailDto = { ...BASE_DETAIL, wiki_window_open: false };
    setupApiFetch({ detail: locked, disputes: [], revisions: [] });
    render(wrap({ children: <InterventionDetail /> }));
    await waitFor(() => expect(screen.getByText(/Audit attivo/)).toBeInTheDocument());
  });

  // 9. Shows "Modifiche libere" banner when wiki_window_open=true
  it('shows "Modifiche libere" banner when wiki_window_open is true', async () => {
    setupApiFetch({ detail: BASE_DETAIL, disputes: [], revisions: [] });
    render(wrap({ children: <InterventionDetail /> }));
    await waitFor(() => expect(screen.getByText(/Modifiche libere/)).toBeInTheDocument());
  });

  // 10. Click "Annulla" opens CancelInterventionDialog
  it('opens CancelInterventionDialog when Annulla button is clicked', async () => {
    const user = userEvent.setup();
    setupApiFetch({ detail: BASE_DETAIL, disputes: [], revisions: [] });
    render(wrap({ children: <InterventionDetail /> }));

    // Wait for the page to render fully
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /Tagliando 30000 km/i })).toBeInTheDocument(),
    );

    // Initially dialog should not show open=true
    expect(screen.queryByTestId('cancel-dialog-open')).not.toBeInTheDocument();

    // Click the Annulla button in the header
    const annullaBtn = screen.getByRole('button', { name: /^Annulla$/i });
    await user.click(annullaBtn);

    // Dialog should now be open
    expect(screen.getByTestId('cancel-dialog-open')).toBeInTheDocument();
  });

  // 11. Renders Ricambi card with populated parts (BR-071 canonical shape)
  it('renders Ricambi card with populated parts using canonical BR-071 shape', async () => {
    const withParts: InterventionDetailDto = {
      ...BASE_DETAIL,
      parts_replaced: [
        { name: 'Olio motore Selenia 5W30', code: 'SEL-5W30-4L', quantity: 4, notes: 'Litri' },
        { name: 'Filtro olio', code: null, quantity: 1, notes: null },
      ],
    };
    setupApiFetch({ detail: withParts, disputes: [], revisions: [] });
    render(wrap({ children: <InterventionDetail /> }));

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /Tagliando 30000 km/i })).toBeInTheDocument(),
    );

    // Ricambi card heading shows correct count
    expect(screen.getByText('Ricambi sostituiti (2)')).toBeInTheDocument();

    // First part: name, code, quantity, notes all rendered
    expect(screen.getByText('Olio motore Selenia 5W30')).toBeInTheDocument();
    expect(screen.getByText(/codice SEL-5W30-4L/)).toBeInTheDocument();
    expect(screen.getByText(/×4/)).toBeInTheDocument();
    expect(screen.getByText(/Litri/)).toBeInTheDocument();

    // Second part: name, quantity rendered; code + notes absent
    expect(screen.getByText('Filtro olio')).toBeInTheDocument();
    expect(screen.getByText(/×1/)).toBeInTheDocument();
  });
});
