import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TenantCatalogVisibility } from '@/pages/TenantCatalogVisibility';
import type { TypeVisibility } from '@/lib/catalog-visibility-types';

// Mock useApiFetch so tests control the API response without real network or
// Cognito dependencies. Mirrors tests/tenant-detail.test.tsx.
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

const TENANT_ID = 'tenant-001';
const VISIBILITY_PATH = `/v1/admin/tenants/${TENANT_ID}/catalog-visibility`;

// Wrap in MemoryRouter + Routes so useParams returns the correct id, and the
// "← Torna all'officina" back-link target exists (avoids a react-router
// "no match" console warning).
function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[`/officine/${TENANT_ID}/visibilita-catalogo`]}>
          <Routes>
            <Route path="/officine/:id/visibilita-catalogo" element={<>{children}</>} />
            <Route path="/officine/:id" element={<div />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

const TYPE_TAGLIANDO: TypeVisibility = {
  id: 'type-001',
  code: 'TAGLIANDO',
  nameIt: 'Tagliando',
  visible: true,
  checklistItems: [
    { id: 'item-001', code: 'OLIO_MOTORE', nameIt: 'Olio motore', sortOrder: 1, visible: true },
    { id: 'item-002', code: 'FILTRO_ARIA', nameIt: 'Filtro aria', sortOrder: 2, visible: false },
  ],
};

beforeEach(() => {
  mockApiFetch.mockReset();
});

describe('TenantCatalogVisibility page', () => {
  it('happy path: renders the type checked and the excluded item unchecked', async () => {
    mockApiFetch.mockResolvedValueOnce({ data: { types: [TYPE_TAGLIANDO] } });

    render(<TenantCatalogVisibility />, { wrapper: makeWrapper() });

    await screen.findByRole('region', { name: 'Tagliando' });
    expect(screen.getByLabelText('Visibile - Tagliando')).toBeChecked();
    expect(screen.getByLabelText('Visibile - Olio motore')).toBeChecked();
    expect(screen.getByLabelText('Visibile - Filtro aria')).not.toBeChecked();
  });

  it('save: unchecking the type sends it in excludedTypeIds via PUT', async () => {
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (init?.method === 'PUT' && path === VISIBILITY_PATH) {
        return Promise.resolve({ excludedTypeIds: [TYPE_TAGLIANDO.id], excludedItemIds: [] });
      }
      return Promise.resolve({ data: { types: [TYPE_TAGLIANDO] } });
    });

    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();

    render(<TenantCatalogVisibility />, { wrapper: makeWrapper() });

    await screen.findByRole('region', { name: 'Tagliando' });
    await user.click(screen.getByLabelText('Visibile - Tagliando'));

    await user.click(screen.getByRole('button', { name: /^salva$/i }));

    expect(mockApiFetch).toHaveBeenCalledWith(
      VISIBILITY_PATH,
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          excludedTypeIds: [TYPE_TAGLIANDO.id],
          // Both checklist items travel with the parent type's exclusion
          // complement — OLIO_MOTORE was visible so it is unaffected by this
          // toggle but FILTRO_ARIA was already excluded from the loaded data.
          excludedItemIds: [TYPE_TAGLIANDO.checklistItems[1].id],
        }),
      }),
    );
  });

  it('error state: GET rejects and the error alert renders without crashing', async () => {
    mockApiFetch.mockRejectedValueOnce(new Error('Network error'));

    render(<TenantCatalogVisibility />, { wrapper: makeWrapper() });

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});
