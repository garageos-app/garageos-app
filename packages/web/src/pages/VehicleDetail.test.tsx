import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { VehicleDetail } from './VehicleDetail';
import { ApiError } from '@/lib/api-client';
import type { TimelineResponse, VehicleDetailResponse } from '@/queries/types';

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
  toast: { error: toastErrorMock },
}));

const VEHICLE_ID = '11111111-1111-4111-8111-111111111111';

const VEHICLE_DETAIL_FIXTURE: VehicleDetailResponse = {
  vehicle: {
    id: VEHICLE_ID,
    garageCode: 'GO-234-ABCD',
    vin: 'ZFA31200000123456',
    plate: 'AB123CD',
    plateCountry: 'IT',
    make: 'Fiat',
    model: 'Panda',
    version: null,
    year: 2021,
    registrationDate: null,
    vehicleType: 'auto',
    fuelType: 'gasoline',
    engineDisplacement: null,
    powerKw: null,
    color: null,
    status: 'certified',
    certifiedAt: '2024-06-01T00:00:00Z',
    certifiedByTenantId: null,
    createdAt: '2024-06-01T00:00:00Z',
  },
  currentOwnership: null,
};

const TIMELINE_FIXTURE: TimelineResponse = {
  data: [
    {
      kind: 'shop_intervention',
      id: 'shop-1',
      intervention_date: '2025-03-15T10:00:00Z',
      odometer_km: 30200,
      type: { id: 'type-tagliando', code: 'TAGLIANDO', name_it: 'Tagliando' },
      title: 'Tagliando 30000 km',
      description: 'Cambio olio.',
      parts_replaced_count: 3,
      status: 'active',
      is_disputed: false,
      wiki_window_open: true,
      tenant: { business_name: 'Officina Rossi', location_city: 'Milano' },
      has_attachments: true,
      attachments_count: 2,
    },
    {
      kind: 'private_intervention',
      id: 'private-1',
      intervention_date: '2025-02-10T08:00:00Z',
      odometer_km: 28100,
      custom_type: 'Cambio gomme',
      description: 'Stagionali invernali.',
      has_attachments: false,
      attachments_count: 0,
    },
  ],
  meta: { has_more: false },
};

function setupApiFetch(opts: {
  detail?: VehicleDetailResponse | ApiError;
  timeline?: TimelineResponse;
}) {
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (path: string) => {
    if (path === `/v1/vehicles/${VEHICLE_ID}`) {
      if (opts.detail instanceof ApiError) throw opts.detail;
      if (opts.detail) return opts.detail;
      throw new Error(`unexpected: ${path}`);
    }
    if (path.startsWith(`/v1/vehicles/${VEHICLE_ID}/timeline`)) {
      if (opts.timeline) return opts.timeline;
      throw new Error(`unexpected: ${path}`);
    }
    throw new Error(`unexpected path: ${path}`);
  });
}

function wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={[`/vehicles/${VEHICLE_ID}`]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/vehicles/:id" element={children} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

describe('VehicleDetail', () => {
  beforeEach(() => {
    navigateMock.mockClear();
    toastErrorMock.mockClear();
  });
  afterEach(() => {
    apiFetchMock.mockReset();
  });

  it('shows skeletons while detail is loading', () => {
    apiFetchMock.mockImplementation(() => new Promise(() => {})); // never resolves
    render(wrap({ children: <VehicleDetail /> }));
    expect(
      document.querySelectorAll('[data-slot="skeleton"], .animate-pulse').length,
    ).toBeGreaterThan(0);
  });

  it('redirects and toasts on 404 vehicle', async () => {
    setupApiFetch({
      detail: new ApiError('vehicle.not_found', 404, 'Veicolo non trovato'),
      timeline: { data: [], meta: { has_more: false } },
    });
    render(wrap({ children: <VehicleDetail /> }));
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith('Veicolo non trovato'));
    expect(navigateMock).toHaveBeenCalledWith('/', { replace: true });
  });

  it('shows generic error alert with Riprova on non-404 detail error', async () => {
    setupApiFetch({
      detail: new ApiError('http.500', 500, 'Internal Server Error'),
      timeline: { data: [], meta: { has_more: false } },
    });
    render(wrap({ children: <VehicleDetail /> }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /riprova/i })).toBeInTheDocument(),
    );
  });

  it('renders header + 2 timeline rows on happy path', async () => {
    setupApiFetch({ detail: VEHICLE_DETAIL_FIXTURE, timeline: TIMELINE_FIXTURE });
    render(wrap({ children: <VehicleDetail /> }));
    await waitFor(() => expect(screen.getByText(/Fiat Panda/)).toBeInTheDocument());
    expect(screen.getByText('Tagliando 30000 km')).toBeInTheDocument();
    expect(screen.getByText('Cambio gomme')).toBeInTheDocument();
  });

  it('disables "Registra intervento" when vehicle is archived', async () => {
    setupApiFetch({
      detail: {
        ...VEHICLE_DETAIL_FIXTURE,
        vehicle: { ...VEHICLE_DETAIL_FIXTURE.vehicle, status: 'archived' },
      },
      timeline: { data: [], meta: { has_more: false } },
    });
    render(wrap({ children: <VehicleDetail /> }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /registra intervento/i })).toBeDisabled(),
    );
  });

  it('shows the empty timeline message when no interventions', async () => {
    setupApiFetch({
      detail: VEHICLE_DETAIL_FIXTURE,
      timeline: { data: [], meta: { has_more: false } },
    });
    render(wrap({ children: <VehicleDetail /> }));
    await waitFor(() =>
      expect(
        screen.getByText('Nessun intervento registrato per questo veicolo.'),
      ).toBeInTheDocument(),
    );
  });

  it('renders VehicleTagPrintButton "Stampa tag" in the header', async () => {
    setupApiFetch({ detail: VEHICLE_DETAIL_FIXTURE, timeline: TIMELINE_FIXTURE });
    render(wrap({ children: <VehicleDetail /> }));
    expect(await screen.findByRole('button', { name: /stampa tag/i })).toBeVisible();
  });
});
