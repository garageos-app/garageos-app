import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { InterventionCreate } from './InterventionCreate';
import { ApiError } from '@/lib/api-client';
import type { CreateInterventionFormValues } from '@/lib/validators/intervention';

const { mockApiFetch, mockToastError } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
  mockToastError: vi.fn(),
}));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
  return { ...actual, useApiFetch: () => mockApiFetch };
});
vi.mock('sonner', () => ({ toast: { error: mockToastError, success: vi.fn() } }));

// Mock InterventionForm to avoid Radix Select JSDOM interaction issues.
// Renders a minimal "Salva intervento" button and captures the onSubmit prop.
vi.mock('@/components/intervention-form/InterventionForm', () => ({
  InterventionForm: ({
    onSubmit,
  }: {
    onSubmit: (v: CreateInterventionFormValues) => void;
    submitting: boolean;
  }) => {
    return (
      <div>
        <label htmlFor="desc">Descrizione</label>
        <textarea id="desc" />
        <button
          type="button"
          onClick={() =>
            onSubmit({
              interventionTypeId: 'uuid-1',
              interventionDate: '2026-05-06',
              odometerKm: 100,
              description: 'test',
              partsReplaced: [],
            })
          }
        >
          Salva intervento
        </button>
      </div>
    );
  },
}));

function setup(initialPath = '/vehicles/v-1/interventions/new') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/vehicles/:id/interventions/new" element={<InterventionCreate />} />
          <Route path="/vehicles/:id" element={<div>Vehicle detail</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockApiFetch.mockReset();
  mockToastError.mockReset();
  // Default: vehicle detail + types responses
  mockApiFetch.mockImplementation(async (path: string) => {
    if (path === '/v1/vehicles/v-1') {
      return {
        vehicle: { id: 'v-1', registrationDate: null, status: 'certified' },
        currentOwnership: null,
      };
    }
    if (path === '/v1/intervention-types') {
      return {
        data: [
          {
            id: 'uuid-1',
            code: 'TAGLIANDO',
            nameIt: 'Tagliando',
            description: '',
            icon: 'wrench',
            category: 'maintenance',
            suggestsDeadline: true,
            defaultDeadlineMonths: 12,
            defaultDeadlineKm: 15000,
            custom: false,
          },
        ],
      };
    }
    throw new Error(`unexpected ${path}`);
  });
});

describe('InterventionCreate', () => {
  it('renders form when types loaded', async () => {
    setup();
    await waitFor(() => expect(screen.getByLabelText(/descrizione/i)).toBeInTheDocument());
  });

  it('opens KmConfirmDialog on 409 odometer_decrease_warning', async () => {
    setup();
    await waitFor(() => expect(screen.getByLabelText(/descrizione/i)).toBeInTheDocument());

    mockApiFetch.mockRejectedValueOnce(
      new ApiError('intervention.creation.odometer_decrease_warning', 409, 'Km bassi (52000)'),
    );
    await userEvent.click(screen.getByRole('button', { name: /salva intervento/i }));
    expect(await screen.findByText(/km inferiori allo storico/i)).toBeInTheDocument();
  });

  it('shows toast on 422 vehicle.modification.archived', async () => {
    setup();
    await waitFor(() => expect(screen.getByLabelText(/descrizione/i)).toBeInTheDocument());

    mockApiFetch.mockRejectedValueOnce(
      new ApiError('vehicle.modification.archived', 422, 'archived'),
    );
    await userEvent.click(screen.getByRole('button', { name: /salva intervento/i }));
    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining('archiviato')),
    );
  });
});
