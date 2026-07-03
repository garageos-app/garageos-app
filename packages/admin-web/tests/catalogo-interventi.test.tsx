import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CatalogoInterventi } from '@/pages/CatalogoInterventi';
import type { InterventionTypeAdmin } from '@/lib/catalog-types';

// Mock useApiFetch so tests control the API response without real network or
// Cognito dependencies. Mirrors tests/tenant-list.test.tsx.
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

// Each test gets a fresh QueryClient to prevent cross-test cache bleed.
function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

const TYPE_TAGLIANDO: InterventionTypeAdmin = {
  id: 'type-001',
  code: 'TAGLIANDO',
  nameIt: 'Tagliando',
  description: 'Tagliando periodico',
  icon: 'wrench',
  suggestsDeadline: true,
  defaultDeadlineMonths: 12,
  defaultDeadlineKm: 15000,
  active: true,
  checklistItemCount: 8,
  createdAt: '2026-01-15T10:00:00.000Z',
  updatedAt: '2026-01-15T10:00:00.000Z',
};

const TYPE_GOMME: InterventionTypeAdmin = {
  id: 'type-002',
  code: 'CAMBIO_GOMME',
  nameIt: 'Cambio gomme',
  description: null,
  icon: null,
  suggestsDeadline: false,
  defaultDeadlineMonths: null,
  defaultDeadlineKm: null,
  active: false,
  checklistItemCount: 0,
  createdAt: '2026-02-20T14:00:00.000Z',
  updatedAt: '2026-02-20T14:00:00.000Z',
};

beforeEach(() => {
  mockApiFetch.mockReset();
});

describe('CatalogoInterventi page', () => {
  it('happy path: renders type rows with code and stato', async () => {
    mockApiFetch.mockResolvedValueOnce({ data: [TYPE_TAGLIANDO, TYPE_GOMME] });

    render(<CatalogoInterventi />, { wrapper: makeWrapper() });

    expect(await screen.findByText('TAGLIANDO')).toBeInTheDocument();
    expect(screen.getByText('Tagliando')).toBeInTheDocument();
    expect(screen.getByText('CAMBIO_GOMME')).toBeInTheDocument();

    // Stato badges
    expect(screen.getByText('Attivo')).toBeInTheDocument();
    expect(screen.getByText('Inattivo')).toBeInTheDocument();

    // Voci (checklistItemCount)
    expect(screen.getByText('8')).toBeInTheDocument();
  });

  it('error state: apiFetch rejects and the error alert renders', async () => {
    mockApiFetch.mockRejectedValueOnce(new Error('Network error'));

    render(<CatalogoInterventi />, { wrapper: makeWrapper() });

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Errore nel caricamento del catalogo.');
  });

  it('create: opens dialog, fills form, submits POST with expected payload', async () => {
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (init?.method === 'POST' && path === '/v1/admin/intervention-types') {
        return Promise.resolve({ interventionType: { ...TYPE_TAGLIANDO, id: 'type-new' } });
      }
      // List query and any refetch after invalidation
      return Promise.resolve({ data: [TYPE_TAGLIANDO] });
    });

    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();

    render(<CatalogoInterventi />, { wrapper: makeWrapper() });
    await screen.findByText('TAGLIANDO');

    await user.click(screen.getByRole('button', { name: /nuovo tipo/i }));

    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Codice'), 'REVISIONE');
    await user.type(within(dialog).getByLabelText('Nome'), 'Revisione periodica');
    // suggestsDeadline/active checkboxes default unchecked/checked respectively — leave as-is.

    await user.click(within(dialog).getByRole('button', { name: /^crea$/i }));

    expect(mockApiFetch).toHaveBeenCalledWith(
      '/v1/admin/intervention-types',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          code: 'REVISIONE',
          nameIt: 'Revisione periodica',
          suggestsDeadline: false,
          defaultDeadlineMonths: null,
          defaultDeadlineKm: null,
          active: true,
        }),
      }),
    );
  });

  // Regression: DELETE must carry a non-empty '{}' body. api-client sets
  // Content-Type: application/json unconditionally; Fastify rejects a body-less
  // DELETE with FST_ERR_CTP_EMPTY_JSON_BODY (400). Caught only by smoke, not
  // by app.inject integration tests. See feedback_fastify_empty_body...
  it('delete: sends DELETE with a non-empty {} body', async () => {
    mockApiFetch.mockImplementation((_path: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return Promise.resolve(undefined);
      return Promise.resolve({ data: [TYPE_TAGLIANDO] });
    });

    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();

    render(<CatalogoInterventi />, { wrapper: makeWrapper() });
    await screen.findByText('TAGLIANDO');

    await user.click(screen.getByRole('button', { name: /^elimina$/i }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /^elimina$/i }));

    expect(mockApiFetch).toHaveBeenCalledWith(
      `/v1/admin/intervention-types/${TYPE_TAGLIANDO.id}`,
      expect.objectContaining({ method: 'DELETE', body: JSON.stringify({}) }),
    );
  });
});
