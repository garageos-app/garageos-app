import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CatalogoInterventoDetail } from '@/pages/CatalogoInterventoDetail';
import type { InterventionTypeAdmin, ChecklistItemAdmin } from '@/lib/catalog-types';

// Mock useApiFetch so tests control the API response without real network or
// Cognito dependencies. Mirrors tests/catalogo-interventi.test.tsx.
const { mockApiFetch } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({
  useApiFetch: () => mockApiFetch,
  ApiError: class ApiError extends Error {
    readonly code: string;
    readonly status: number;
    constructor(code: string, status: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.code = code;
      this.status = status;
    }
  },
}));

vi.mock('@/auth/useAuth', () => ({
  useAuth: () => ({
    signOut: vi.fn(),
    state: { status: 'authenticated', user: { email: 'admin@garageos.it' } },
    signIn: vi.fn(),
    getIdToken: vi.fn(),
    completeNewPassword: vi.fn(),
  }),
}));

const TYPE_ID = '11111111-1111-1111-1111-111111111111';

// Each test gets a fresh QueryClient to prevent cross-test cache bleed. The
// route is wrapped in <Routes>/<Route path="/catalogo/:id"> so useParams()
// resolves against the MemoryRouter's initialEntries.
function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[`/catalogo/${TYPE_ID}`]}>
          <Routes>
            <Route path="/catalogo/:id" element={children} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

const TYPE_TAGLIANDO: InterventionTypeAdmin = {
  id: TYPE_ID,
  code: 'TAGLIANDO',
  nameIt: 'Tagliando',
  description: 'Tagliando periodico',
  icon: 'wrench',
  category: 'maintenance',
  suggestsDeadline: true,
  defaultDeadlineMonths: 12,
  defaultDeadlineKm: 15000,
  active: true,
  checklistItemCount: 2,
  createdAt: '2026-01-15T10:00:00.000Z',
  updatedAt: '2026-01-15T10:00:00.000Z',
};

const ITEM_OLIO: ChecklistItemAdmin = {
  id: 'item-001',
  interventionTypeId: TYPE_ID,
  code: 'OLIO_MOTORE',
  nameIt: 'Olio motore',
  sortOrder: 1,
  active: true,
  createdAt: '2026-01-15T10:00:00.000Z',
  updatedAt: '2026-01-15T10:00:00.000Z',
};

const ITEM_FILTRO: ChecklistItemAdmin = {
  id: 'item-002',
  interventionTypeId: TYPE_ID,
  code: 'FILTRO_ARIA',
  nameIt: 'Filtro aria',
  sortOrder: 2,
  active: false,
  createdAt: '2026-01-15T10:00:00.000Z',
  updatedAt: '2026-01-15T10:00:00.000Z',
};

const TYPES_PATH = '/v1/admin/intervention-types';
const ITEMS_PATH = `/v1/admin/intervention-types/${TYPE_ID}/checklist-items`;

beforeEach(() => {
  mockApiFetch.mockReset();
});

describe('CatalogoInterventoDetail page', () => {
  it('happy path: renders header and checklist item rows', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === TYPES_PATH) return Promise.resolve({ data: [TYPE_TAGLIANDO] });
      if (path === ITEMS_PATH) return Promise.resolve({ data: [ITEM_OLIO, ITEM_FILTRO] });
      throw new Error(`Unexpected path: ${path}`);
    });

    render(<CatalogoInterventoDetail />, { wrapper: makeWrapper() });

    expect(await screen.findByText('Tagliando (TAGLIANDO)')).toBeInTheDocument();
    expect(screen.getByText('OLIO_MOTORE')).toBeInTheDocument();
    expect(screen.getByText('Olio motore')).toBeInTheDocument();
    expect(screen.getByText('FILTRO_ARIA')).toBeInTheDocument();
    expect(screen.getByText('Attivo')).toBeInTheDocument();
    expect(screen.getByText('Inattivo')).toBeInTheDocument();
  });

  it('error state: checklist-items fetch rejects and the error alert renders', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === TYPES_PATH) return Promise.resolve({ data: [TYPE_TAGLIANDO] });
      if (path === ITEMS_PATH) return Promise.reject(new Error('Network error'));
      throw new Error(`Unexpected path: ${path}`);
    });

    render(<CatalogoInterventoDetail />, { wrapper: makeWrapper() });

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Errore nel caricamento delle voci.');
  });

  it('create: opens dialog, fills form, submits POST with expected payload', async () => {
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (init?.method === 'POST' && path === ITEMS_PATH) {
        return Promise.resolve({ checklistItem: { ...ITEM_OLIO, id: 'item-new' } });
      }
      if (path === TYPES_PATH) return Promise.resolve({ data: [TYPE_TAGLIANDO] });
      if (path === ITEMS_PATH) return Promise.resolve({ data: [ITEM_OLIO] });
      throw new Error(`Unexpected path: ${path}`);
    });

    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();

    render(<CatalogoInterventoDetail />, { wrapper: makeWrapper() });
    await screen.findByText('OLIO_MOTORE');

    await user.click(screen.getByRole('button', { name: /nuova voce/i }));

    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Codice'), 'FILTRO_OLIO');
    await user.type(within(dialog).getByLabelText('Nome'), 'Filtro olio');
    await user.clear(within(dialog).getByLabelText('Ordine'));
    await user.type(within(dialog).getByLabelText('Ordine'), '3');
    // active checkbox defaults checked — leave as-is.

    await user.click(within(dialog).getByRole('button', { name: /^crea$/i }));

    expect(mockApiFetch).toHaveBeenCalledWith(
      ITEMS_PATH,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          code: 'FILTRO_OLIO',
          nameIt: 'Filtro olio',
          sortOrder: 3,
          active: true,
        }),
      }),
    );
  });
});
