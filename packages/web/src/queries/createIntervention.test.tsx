import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

import { useCreateIntervention } from './createIntervention';
import { ApiError } from '@/lib/api-client';

const { mockApiFetch, mockNavigate, mockToastSuccess } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
  mockNavigate: vi.fn(),
  mockToastSuccess: vi.fn(),
}));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
  return {
    ...actual,
    useApiFetch: () => mockApiFetch,
  };
});
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});
vi.mock('sonner', () => ({ toast: { success: mockToastSuccess, error: vi.fn() } }));

function wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('useCreateIntervention', () => {
  it('happy path: invalidates timeline + navigates', async () => {
    mockApiFetch.mockResolvedValueOnce({ intervention: { id: 'i1' }, deadline: null });
    const { result } = renderHook(() => useCreateIntervention('v-1'), { wrapper: wrap });
    await result.current.mutateAsync({
      interventionTypeId: 'uuid',
      interventionDate: '2026-05-06',
      odometerKm: 50000,
      description: 'x',
      partsReplaced: [],
    });
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalled());
    expect(mockNavigate).toHaveBeenCalledWith('/vehicles/v-1');
  });

  it('propagates 409 ApiError to caller', async () => {
    mockApiFetch.mockRejectedValueOnce(
      new ApiError('intervention.creation.odometer_decrease_warning', 409, 'Km bassi'),
    );
    const { result } = renderHook(() => useCreateIntervention('v-2'), { wrapper: wrap });
    await expect(
      result.current.mutateAsync({
        interventionTypeId: 'uuid',
        interventionDate: '2026-05-06',
        odometerKm: 1,
        description: 'x',
        partsReplaced: [],
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'intervention.creation.odometer_decrease_warning',
    });
  });
});
